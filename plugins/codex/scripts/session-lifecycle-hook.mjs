#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import {
  applyJobPatchIfActive,
  hasActiveBackgroundJobs,
  loadState,
  resolveStateFile,
  saveState,
  writeCompletionSignalFile
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { readHookInput } from "./lib/hook-input.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const sessionJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (sessionJobs.length === 0) {
    return;
  }

  const completedAt = new Date().toISOString();
  const keptIds = new Set();

  for (const job of sessionJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue; // terminal session jobs are cleaned up (removed) below
    }
    if (job.background === true) {
      // Background jobs are designed to outlive the session — do NOT terminate
      // them. They are still bounded by the liveness watchdog and the 15-minute
      // hard cap. They are retained in the index below so the parent session's
      // later /codex:status can still find them.
      continue;
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
    // Mark the killed job failed and emit a .done signal so a result query
    // returns a clear reason — and any monitor waiting on the signal stops —
    // instead of the job silently vanishing from state.
    const reason = "Session ended before the Codex job completed; marked failed.";
    const result = applyJobPatchIfActive(workspaceRoot, job.id, () => ({
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      errorMessage: reason,
      endedBySession: true
    }));
    if (result.applied) {
      writeCompletionSignalFile(workspaceRoot, job.id, { status: "failed", reason });
      keptIds.add(job.id);
    }
  }

  // Reload to pick up the failed transitions, then drop the terminal session
  // jobs while retaining the ones we just marked failed (so /codex:result can
  // still surface them and their .done signal is not pruned).
  const fresh = loadState(workspaceRoot);
  saveState(workspaceRoot, {
    ...fresh,
    jobs: fresh.jobs.filter(
      (job) => job.sessionId !== sessionId || keptIds.has(job.id) || job.background === true
    )
  });
}

// The shared per-workspace broker is torn down at SessionEnd only when it did NOT
// refuse as busy AND no background job is still active in this workspace — a
// surviving background job must keep its app-server (the broker) alive.
export function shouldTeardownBroker(shutdownResult, hasActiveBackground) {
  return !shutdownResult.busy && !hasActiveBackground;
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

export async function handleSessionEnd(input, deps = {}) {
  // Injectable seams (default to the real imports) so the integrated
  // shutdown -> cleanup -> teardown-decision path is testable without spawning a
  // real broker or touching real processes.
  const sendShutdown = deps.sendBrokerShutdown ?? sendBrokerShutdown;
  const teardown = deps.teardownBrokerSession ?? teardownBrokerSession;
  const hasActiveBackground = deps.hasActiveBackgroundJobs ?? hasActiveBackgroundJobs;
  const cleanup = deps.cleanupSessionJobs ?? cleanupSessionJobs;

  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const backgroundActive = hasActiveBackground(workspaceRoot);

  let shutdownResult = { busy: false };
  try {
    // Gate the self-shutdown RPC on active background jobs too — not only the local
    // teardown below. sendBrokerShutdown asks the broker to exit ITSELF, and the
    // broker's busy-gate (shouldRefuseBrokerShutdown) only refuses while another
    // socket owns an in-flight request/stream. A surviving background job that is
    // queued / connecting / between its thread/start and turn/start owns no active
    // socket, so the broker would NOT report busy and would exit — orphaning that
    // job's app-server. Skipping the RPC here keeps the RPC decision symmetric with
    // the already-gated teardown and honours the #355 background-survival intent.
    if (brokerEndpoint && !backgroundActive) {
      shutdownResult = await sendShutdown(brokerEndpoint);
    }
  } finally {
    // This session's foreground jobs end; background jobs survive (handled inside).
    cleanup(cwd, input.session_id || process.env[SESSION_ID_ENV]);

    // Only tear the broker down if it did NOT refuse as busy AND no background job
    // is still active. The broker is shared per-workspace; if another session/
    // client is mid-turn it returns a busy error, and force-killing it here would
    // abort that client's turn (the busy-gate in broker/shutdown would otherwise
    // be defeated by this teardown). A surviving background job likewise needs its
    // app-server (the broker) kept alive. A timeout/other failure leaves
    // shutdownResult.busy false, so a genuinely wedged broker is still reaped.
    if (shouldTeardownBroker(shutdownResult, backgroundActive)) {
      teardown({
        endpoint: brokerEndpoint,
        pidFile,
        logFile,
        sessionDir,
        pid,
        killProcess: terminateProcessTree
      });
      clearBrokerSession(cwd);
    }
  }
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export { cleanupSessionJobs };

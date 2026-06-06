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
  loadState,
  resolveStateFile,
  saveState,
  writeCompletionSignalFile
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

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
    jobs: fresh.jobs.filter((job) => job.sessionId !== sessionId || keptIds.has(job.id))
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
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

  try {
    if (brokerEndpoint) {
      await sendBrokerShutdown(brokerEndpoint);
    }
  } finally {
    // Always tear down — even if the graceful shutdown RPC threw — so we never
    // leak the broker process, its temp files, or a stale broker.json that the
    // next session would try to reuse. (The shutdown RPC is now time-bounded, so
    // this also cannot sit behind an unbounded await and miss the 5s hook
    // timeout.)
    cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
    teardownBrokerSession({
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

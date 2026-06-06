#!/usr/bin/env node
// Detached liveness watchdog for a single background Codex job.
//
// Spawned alongside a background worker (detached, stdio ignored). Every
// ~5 minutes it observes the job: is the worker process alive, how long since
// the last logged event, and is the broker endpoint still reachable. It uses
// the pure liveness logic in lib/liveness.mjs (escalate-not-kill) and, only
// after repeated bad ticks, interrupts the turn, kills the process tree, marks
// the job failed, and writes a .done signal so /codex:result returns a reason
// instead of hanging forever.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isProcessAlive, terminateProcessTree } from "./lib/process.mjs";
import { loadBrokerSession, waitForBrokerEndpoint } from "./lib/broker-lifecycle.mjs";
import {
  applyJobPatchIfActive,
  readJobFile,
  resolveJobFile,
  writeCompletionSignalFile
} from "./lib/state.mjs";
import { appendLogLine, nowIso } from "./lib/tracked-jobs.mjs";
import { createLivenessGate, resolveWatchdogConfig } from "./lib/liveness.mjs";

// Margin past a job's own declared hard-timeout deadline before the watchdog
// treats it as missed — avoids racing the worker's in-process timeout firing.
const DEADLINE_GRACE_MS = 60_000;

export function makeDefaultDeps() {
  return {
    readJob: (cwd, jobId) => {
      try {
        return readJobFile(resolveJobFile(cwd, jobId));
      } catch {
        return null;
      }
    },
    isProcessAlive,
    statLogMtimeMs: (logFile) => {
      try {
        return fs.statSync(logFile).mtimeMs;
      } catch {
        return null;
      }
    },
    probeBroker: async (cwd) => {
      const session = loadBrokerSession(cwd);
      if (!session?.endpoint) {
        return false;
      }
      try {
        return await waitForBrokerEndpoint(session.endpoint, 300);
      } catch {
        return false;
      }
    },
    interrupt: async (cwd, ctx) => {
      try {
        // Lazy import so the watchdog's testable core never pulls in the heavy
        // app-server stack; tests inject their own interrupt dep.
        const { interruptAppServerTurn } = await import("./lib/codex.mjs");
        return await interruptAppServerTurn(cwd, ctx);
      } catch {
        // Best effort — interrupt is a courtesy before the hard kill. Report it
        // as unconfirmed so the caller escalates to reaping the broker.
        return { attempted: false, interrupted: false };
      }
    },
    readBrokerPid: (cwd) => {
      try {
        const session = loadBrokerSession(cwd);
        return Number.isInteger(session?.pid) ? session.pid : null;
      } catch {
        return null;
      }
    },
    terminate: (pid) => {
      try {
        terminateProcessTree(pid);
      } catch {
        // Already gone.
      }
    },
    now: () => Date.now()
  };
}

export async function gatherObservation(cwd, jobId, deps, config) {
  const job = deps.readJob(cwd, jobId);
  if (!job) {
    return null;
  }

  const pid = Number(job.pid);
  const hasPid = Number.isFinite(pid) && pid > 0;
  const workerAlive = hasPid ? Boolean(deps.isProcessAlive(pid)) : false;

  const mtime = job.logFile ? deps.statLogMtimeMs(job.logFile) : null;
  const quietMs = mtime == null ? 0 : Math.max(0, deps.now() - mtime);

  const brokerOk = Boolean(await deps.probeBroker(cwd));

  const deadlineMs = job.timeoutAt ? Date.parse(job.timeoutAt) : NaN;
  const missedOwnDeadline = Number.isFinite(deadlineMs) && deps.now() > deadlineMs + DEADLINE_GRACE_MS;

  return {
    status: job.status,
    pid: hasPid ? Math.trunc(pid) : null,
    workerAlive,
    quietMs,
    brokerOk,
    missedOwnDeadline,
    thresholds: { hangQuietMs: config.hangQuietMs },
    threadId: job.threadId ?? null,
    turnId: job.turnId ?? null,
    logFile: job.logFile ?? null
  };
}

export async function terminateHungJob(cwd, jobId, observation, deps, verdict) {
  const resumeHint = observation.threadId ? ` Resume with: codex resume ${observation.threadId}` : "";
  let reason;
  if (verdict === "DEAD") {
    reason = `Watchdog: worker process ${observation.pid ?? "?"} is no longer running but the job never reported a terminal status. Marked failed.`;
  } else if (observation.missedOwnDeadline) {
    reason = `Watchdog: the worker blew past its own hard-timeout deadline without self-terminating (likely event-loop wedged). Marked failed.${resumeHint}`;
  } else {
    reason = `Watchdog: the Codex turn appears hung (no events for too long and the broker was unreachable). Marked failed.${resumeHint}`;
  }

  // CAS first: only act if the job is still active. If it completed/cancelled
  // between observation and now, this skips — we must not interrupt/kill a
  // finished turn nor overwrite its terminal signal.
  const completedAt = nowIso();
  const result = applyJobPatchIfActive(cwd, jobId, () => ({
    status: "failed",
    phase: "failed",
    pid: null,
    completedAt,
    errorMessage: reason,
    watchdogTerminated: true,
    watchdogVerdict: verdict
  }));
  if (!result.applied) {
    return { skipped: true };
  }

  // interruptAppServerTurn no-ops unless BOTH ids are present (gating on OR made
  // the watchdog believe it interrupted when the RPC silently did nothing).
  // Capture the result so we can tell whether the turn was actually stopped.
  let interruptResult = null;
  if (observation.threadId && observation.turnId) {
    interruptResult = await deps.interrupt(cwd, { threadId: observation.threadId, turnId: observation.turnId });
  }
  if (observation.pid) {
    deps.terminate(observation.pid);
  }

  // The hung turn runs inside `codex app-server`, a child of the BROKER's
  // process group, so terminating the worker tree does not stop it. The broker
  // is shared per-workspace, so reaping it is a LAST resort: only do it for a
  // genuine HUNG turn that we have identity for, where the courtesy interrupt
  // was attempted but did not confirm AND the broker is unreachable. Skip it for
  // a DEAD worker (no turn to reap), when we lack thread/turn identity, when the
  // broker is still reachable, or when the interrupt was merely busy-refused
  // (another client is mid-turn) — killing the broker there would abort their
  // turn.
  const interruptConfirmed = Boolean(interruptResult && interruptResult.interrupted);
  const interruptBusyRefusal = /Shared Codex broker is busy/i.test(interruptResult?.detail ?? "");
  const shouldReapBroker =
    verdict === "HUNG" &&
    Boolean(observation.threadId) &&
    Boolean(observation.turnId) &&
    Boolean(interruptResult?.attempted) &&
    !interruptConfirmed &&
    observation.brokerOk === false &&
    !interruptBusyRefusal;
  if (shouldReapBroker && deps.readBrokerPid) {
    const brokerPid = deps.readBrokerPid(cwd);
    if (Number.isInteger(brokerPid) && brokerPid > 0) {
      deps.terminate(brokerPid);
      if (observation.logFile) {
        try {
          appendLogLine(
            observation.logFile,
            `Watchdog: turn interrupt unconfirmed and broker unreachable; terminated broker process ${brokerPid} to reap the orphaned app-server turn.`
          );
        } catch {
          // Logging is best effort.
        }
      }
    }
  }

  if (observation.logFile) {
    try {
      appendLogLine(observation.logFile, reason);
    } catch {
      // Logging is best effort.
    }
  }

  writeCompletionSignalFile(cwd, jobId, { status: "failed", reason });
  return { reason };
}

export async function runWatchdog(cwd, jobId, options = {}) {
  const env = options.env ?? process.env;
  const deps = options.deps ?? makeDefaultDeps();
  const config = options.config ?? resolveWatchdogConfig(env);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const gate = createLivenessGate(config);

  for (;;) {
    const observation = await gatherObservation(cwd, jobId, deps, config);
    if (!observation) {
      return; // job record pruned/removed — nothing left to watch.
    }

    const { verdict, action } = gate.assess(observation);
    if (action === "stop") {
      return; // job reached a terminal state on its own.
    }
    if (action === "terminate") {
      await terminateHungJob(cwd, jobId, observation, deps, verdict);
      return;
    }

    await sleep(config.intervalMs);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--cwd") out.cwd = argv[++i];
    else if (argv[i] === "--job") out.jobId = argv[++i];
  }
  return out;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const { cwd, jobId } = parseArgs(process.argv.slice(2));
  if (!cwd || !jobId) {
    process.stderr.write("codex-watchdog: --cwd and --job are required\n");
    process.exit(2);
  }
  runWatchdog(cwd, jobId).then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`codex-watchdog: ${error?.message ?? error}\n`);
      process.exit(1);
    }
  );
}

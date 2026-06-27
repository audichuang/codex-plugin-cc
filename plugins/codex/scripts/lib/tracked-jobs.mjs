import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./process.mjs";

import {
  applyJobPatchIfActive,
  claimTerminalTransition,
  loadState,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  writeCompletionSignalFile,
  writeJobFile
} from "./state.mjs";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

// Returns the index's terminal status for a job (completed/failed/cancelled),
// or null when the job is absent or still active. Exported so the cancel handler
// can report the real outcome when it loses the terminal race. The stored===null
// recreate fallbacks no longer rely on this — they go through the cross-process
// O_EXCL claim (claimTerminalTransition) so first-terminal-writer-wins holds even
// when the per-job file was pruned.
export function indexedTerminalStatus(workspaceRoot, jobId) {
  const entry = loadState(workspaceRoot).jobs.find((job) => job.id === jobId);
  return entry && TERMINAL_STATUSES.has(entry.status) ? entry.status : null;
}

// Lazy import so this module never statically depends on the heavy app-server
// stack (codex.mjs). Used only on the timeout path to ask Codex to abort a
// turn that is almost certainly hung.
async function defaultInterruptOnTimeout(cwd, ctx) {
  try {
    const { interruptAppServerTurn } = await import("./codex.mjs");
    await interruptAppServerTurn(cwd, ctx);
  } catch {
    // Best effort — the job is being marked failed regardless.
  }
}

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
export const JOB_TIMEOUT_ENV = "CODEX_JOB_TIMEOUT_MS";
// Unconditional wall-clock backstop for a background job (layer 2). A single
// task call can legitimately run many TDD cycles (npm/vitest/tsc), so 1h is long
// enough not to cut a healthy long job, yet short enough that a wedged job never
// runs all day. A confirmed-dead job (broker unreachable + silent past the
// watchdog's hangQuietMs) is still reaped in ~15 min, independent of this cap.
// Override per-call with options.timeoutMs / --timeout-ms, or via CODEX_JOB_TIMEOUT_MS.
export const DEFAULT_JOB_TIMEOUT_MS = 60 * 60 * 1000;

export function nowIso() {
  return new Date().toISOString();
}

function resolveJobTimeoutMs(options) {
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    return options.timeoutMs;
  }
  const envValue = Number(process.env[JOB_TIMEOUT_ENV]);
  if (Number.isFinite(envValue) && envValue > 0) {
    return envValue;
  }
  return DEFAULT_JOB_TIMEOUT_MS;
}

function formatTimeoutHuman(ms) {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
  return `${ms}ms`;
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    // Suppress progress updates once the job has already reached a terminal
    // state. Without this, a runner that keeps producing events after the
    // layer-2 hard timeout rejected Promise.race would race the failure
    // write (`phase: failed`) back into `phase: investigating`, flicker
    // `updatedAt`, and pollute the persisted record with stale fields.
    applyJobPatchIfActive(workspaceRoot, jobId, patch);
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

// Last-resort crash net for a tracked job. Installed by runTrackedJob for exactly
// the duration of the run and removed in its finally — never a permanent global
// listener (that would change Node's default fatal behavior for unrelated, non-job
// companion subcommands such as status/result/cancel). While a job is in flight, an
// uncaught exception or unhandled rejection — e.g. a synchronous throw from a
// transport stream `data` listener, which never reaches runTrackedJob's try/catch —
// would otherwise kill the worker with NO terminal write, surfacing only later as
// the cryptic "exited without reporting a terminal status" dead-PID reconcile. This
// converts any such crash into a RECORDED failure (real error), writes the .done
// signal so a waiting monitor wakes, then exits nonzero so the death is unambiguous.
//
// First-terminal-writer-wins: mirrors runTrackedJob's failure path (CAS via
// applyJobPatchIfActive; guarded recreate only when the file was pruned AND the
// cross-process terminal claim is won), so it never resurrects a terminal record nor
// stomps a .done another actor (watchdog/cancel/reconcile) already wrote. It does
// NOT touch the shared broker: the orphaned Codex turn (which runs on the broker,
// not in this worker) is left to the watchdog/idle layers — recording the death is
// this net's job, reaping the turn is not.
export function installJobCrashNet(job, runningRecord, options = {}) {
  const proc = options.proc ?? process;
  const now = options.now ?? nowIso;
  const exit = options.exit ?? ((code) => proc.exit(code));
  const logFile = options.logFile ?? job.logFile ?? runningRecord?.logFile ?? null;
  // Reaping the orphaned turn: the crashed worker's death does NOT stop the Codex
  // turn (it runs on the shared broker, not in this process). Best-effort interrupt
  // it via the broker when its identity is known — NEVER touch the broker process.
  const interrupt = options.interruptOnCrash ?? defaultInterruptOnTimeout;
  const interruptTimeoutMs = Number.isFinite(options.interruptTimeoutMs) ? options.interruptTimeoutMs : 3000;
  const readStoredJob =
    options.readJob ??
    (() => {
      try {
        return readJobFile(resolveJobFile(job.workspaceRoot, job.id));
      } catch {
        return null;
      }
    });
  let fired = false;

  const onFatal = async (error) => {
    if (fired) {
      return; // a single crash; ignore secondary errors triggered during teardown
    }
    fired = true;

    // Capture turn identity from the per-job file (the progress updater writes
    // threadId/turnId there once the turn starts) BEFORE finalizing, so we can
    // reap the orphaned turn even though the finalize patch sets pid:null.
    const stored = readStoredJob();
    const threadId = stored?.threadId ?? null;
    const turnId = stored?.turnId ?? null;

    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    const reason = `Worker process crashed with an uncaught error; auto-finalized as failed: ${detail}`;
    const completedAt = now();
    const failurePatch = {
      status: "failed",
      phase: "failed",
      errorMessage: reason,
      pid: null,
      completedAt,
      crashed: true
    };

    let wrote = false;
    try {
      const result = applyJobPatchIfActive(job.workspaceRoot, job.id, (existing) => ({
        ...failurePatch,
        logFile: logFile ?? existing.logFile ?? null
      }));
      wrote = result.applied;
      if (
        !wrote &&
        result.stored === null &&
        !indexedTerminalStatus(job.workspaceRoot, job.id) &&
        claimTerminalTransition(job.workspaceRoot, job.id, "failed", completedAt)
      ) {
        writeJobFile(job.workspaceRoot, job.id, {
          ...runningRecord,
          ...failurePatch,
          logFile: logFile ?? runningRecord?.logFile ?? null
        });
        upsertJob(job.workspaceRoot, { id: job.id, ...failurePatch });
        wrote = true;
      }
    } catch {
      // Never let the crash handler itself throw before it can exit.
    }

    if (wrote) {
      try {
        appendLogLine(logFile, reason);
      } catch {
        // best effort — logging must never block the exit
      }
      try {
        writeCompletionSignalFile(job.workspaceRoot, job.id, { status: "failed", reason });
      } catch {
        // best effort
      }
    }

    // Best-effort, bounded reap of the orphaned turn. Recording the death above is
    // the primary job and is already done, so this must never block the exit:
    // registering an uncaughtException/unhandledRejection listener suppresses Node's
    // auto-exit, so we keep control and terminate via exit() once the interrupt
    // resolves or the bound elapses (a hung/unreachable broker can't wedge us here).
    if (threadId && turnId) {
      let timer = null;
      try {
        await Promise.race([
          Promise.resolve(interrupt(job.cwd ?? job.workspaceRoot, { threadId, turnId })),
          new Promise((resolve) => {
            timer = setTimeout(resolve, interruptTimeoutMs);
            timer?.unref?.();
          })
        ]);
      } catch {
        // best effort — the failure is already recorded regardless
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    }

    exit(1);
  };

  proc.on("uncaughtException", onFatal);
  proc.on("unhandledRejection", onFatal);

  return () => {
    proc.removeListener("uncaughtException", onFatal);
    proc.removeListener("unhandledRejection", onFatal);
  };
}

export async function runTrackedJob(job, runner, options = {}) {
  const timeoutMs = resolveJobTimeoutMs(options);
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null,
    timeoutAt: new Date(Date.now() + timeoutMs).toISOString(),
    timeoutMs
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  // Crash net for the duration of the run: any uncaught throw / unhandled
  // rejection that bypasses the try/catch below (notably a synchronous throw from
  // a transport stream listener) is recorded as a terminal failure instead of a
  // silent worker death. Disposed in the finally so it is never a permanent global
  // listener.
  const disposeCrashNet = installJobCrashNet(job, runningRecord, {
    logFile: options.logFile ?? job.logFile ?? null,
    proc: options.proc,
    exit: options.exit,
    now: options.now
  });

  // Layer-2 watchdog: no matter what goes wrong inside runner (captureTurn
  // hang, broker wedge, internal deadlock), this timer guarantees the job
  // reaches a terminal state. Layer 1 (captureTurn exitPromise watchdog) and
  // layer 3 (listJobs dead-PID reconciliation) catch most cases — this is
  // the backstop for the rest.
  let timeoutHandle = null;
  let timedOut = false;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      reject(new Error(
        `Tracked job ${job.id} exceeded the ${formatTimeoutHuman(timeoutMs)} hard timeout; the job record was marked failed and the Codex turn was sent an interrupt. If it keeps consuming resources, kill it manually.`
      ));
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    const execution = await Promise.race([runner(), timeoutPromise]);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const phase = completionStatus === "completed" ? "done" : "failed";

    // First-terminal-writer-wins via the shared CAS. If an external actor
    // (watchdog / dead-PID reconcile) already finalized this job in a race —
    // including the event-loop-wedged case where the worker resolves success
    // microtask-first after blowing past its own deadline — applied=false and
    // we neither resurrect the record nor clobber its terminal .done. The heavy
    // result/rendered go to the per-job file; the index stays light.
    const result = applyJobPatchIfActive(
      job.workspaceRoot,
      job.id,
      () => ({
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        pid: null,
        phase,
        completedAt,
        result: execution.payload,
        rendered: execution.rendered
      }),
      null,
      () => ({
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        summary: execution.summary,
        phase,
        pid: null,
        completedAt
      })
    );

    // Defensive fallback (mirror of the failure path): if the per-job file
    // vanished (pruned while a silent long job was still alive), the CAS reads
    // stored===null and does not apply. Recreate the terminal record directly
    // so a successful run is not silently dropped — keeping the index light.
    // BUT only if no other actor already finalized the job; the recreate goes
    // through the SAME cross-process O_EXCL terminal claim as the normal path,
    // so two pruned-file recreaters (e.g. runner success vs cancel/watchdog)
    // cannot both write a terminal record — first-terminal-writer-wins holds.
    const recreateSuccess =
      !result.applied &&
      result.stored === null &&
      !indexedTerminalStatus(job.workspaceRoot, job.id) &&
      claimTerminalTransition(job.workspaceRoot, job.id, completionStatus, completedAt);
    if (recreateSuccess) {
      writeJobFile(job.workspaceRoot, job.id, {
        ...runningRecord,
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        pid: null,
        phase,
        completedAt,
        result: execution.payload,
        rendered: execution.rendered
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        summary: execution.summary,
        phase,
        pid: null,
        completedAt
      });
    }

    if (result.applied || recreateSuccess) {
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
      // Terminal signal so a monitor (Claude-side `until [ -f signalFile ]` loop
      // or the detached watchdog) learns the job finished and can surface the
      // result instead of waiting forever.
      writeCompletionSignalFile(job.workspaceRoot, job.id, {
        status: completionStatus,
        reason: completionStatus === "failed" ? execution.summary ?? null : null
      });
    }
    return execution;
  } catch (error) {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);

    // An ETURNIDLE rejection is captureTurn's idle watchdog firing: the turn is
    // wedged (no app-server activity for the idle window) but the worker itself is
    // healthy. Like the hard timeout — and UNLIKE a normal failure — the underlying
    // Codex turn has NOT been unwound (closing the broker socket does not stop it),
    // so it needs the same best-effort interrupt + terminate remediation. Without
    // this the idle watchdog would mark the job failed yet leave an orphan turn
    // running on the shared broker (the exact thing its error message promises to
    // interrupt + reap).
    const idleTimedOut = error?.code === "ETURNIDLE";

    // On a hard timeout (or idle watchdog) the underlying Codex turn is almost
    // certainly still running. Best-effort interrupt it — using the thread/turn the
    // progress updater recorded on the job, falling back to the ids carried on the
    // idle error — so Codex stops working instead of being orphaned.
    if (timedOut || idleTimedOut) {
      const interrupt = options.interruptOnTimeout ?? defaultInterruptOnTimeout;
      try {
        const stored = readJobFile(resolveJobFile(job.workspaceRoot, job.id));
        // interruptAppServerTurn no-ops unless BOTH ids are present; gate on AND
        // so a half-populated record does not trigger a guaranteed-useless RPC.
        const threadId = stored?.threadId ?? error?.threadId ?? null;
        const turnId = stored?.turnId ?? error?.turnId ?? null;
        if (threadId && turnId) {
          await interrupt(job.cwd ?? job.workspaceRoot, { threadId, turnId });
        }
      } catch {
        // Best effort; never let interrupt failures mask the original error.
      }
    }

    const completedAt = nowIso();
    const failurePatch = {
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      ...(timedOut ? { timedOut: true } : {}),
      ...(idleTimedOut ? { idleTimedOut: true } : {})
    };

    // Route the failure write through the CAS helper so we never clobber a
    // record that was already transitioned to a terminal state by layer-3
    // dead-PID reconciliation (e.g. another companion observed this PID as
    // dead first). If the record is still active, we write atomically.
    const result = applyJobPatchIfActive(
      job.workspaceRoot,
      job.id,
      (existing) => ({
        ...failurePatch,
        logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
      })
    );

    // Defensive fallback: if the per-job file somehow went missing between
    // runningRecord write and now, the helper returns applied=false with
    // stored=null. Fall back to a direct write so the job does not silently
    // disappear — but only if we win the SAME cross-process terminal claim as the
    // normal path (first-terminal-writer-wins; do not resurrect another actor's
    // terminal state).
    const recreateFailure =
      !result.applied &&
      result.stored === null &&
      !indexedTerminalStatus(job.workspaceRoot, job.id) &&
      claimTerminalTransition(job.workspaceRoot, job.id, "failed", completedAt);
    if (recreateFailure) {
      writeJobFile(job.workspaceRoot, job.id, {
        ...runningRecord,
        ...failurePatch,
        logFile: options.logFile ?? job.logFile ?? runningRecord.logFile ?? null
      });
      upsertJob(job.workspaceRoot, { id: job.id, ...failurePatch });
    }
    // Terminal signal on the failure path too, so a waiting monitor stops and
    // the failure reason can be surfaced rather than hanging — but ONLY if we
    // actually wrote the failure. If the CAS lost because another actor already
    // finalized the job (e.g. user cancel, watchdog), do not stomp its terminal
    // signal with "failed".
    if (result.applied || recreateFailure) {
      writeCompletionSignalFile(job.workspaceRoot, job.id, {
        status: "failed",
        reason: errorMessage
      });
    }

    // On a hard timeout (or idle watchdog) the runner may still be holding open
    // handles (the broker socket), which can keep this process from exiting even
    // after it reported failure. Schedule a process-tree terminate; .unref() means
    // it only fires if the loop is otherwise blocked (i.e. genuinely stuck), so a
    // process that can exit cleanly still does.
    if (timedOut || idleTimedOut) {
      const terminate = options.terminateOnTimeout ?? terminateProcessTree;
      const pid = Number(result.stored?.pid ?? runningRecord.pid);
      if (Number.isFinite(pid) && pid > 0) {
        setTimeout(() => {
          try {
            terminate(pid);
          } catch {
            // Already gone.
          }
        }, 0).unref?.();
      }
    }
    throw error;
  } finally {
    disposeCrashNet();
  }
}

import fs from "node:fs";
import process from "node:process";

import { applyJobPatchIfActive, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
export const JOB_TIMEOUT_ENV = "CODEX_JOB_TIMEOUT_MS";
export const DEFAULT_JOB_TIMEOUT_MS = 15 * 60 * 1000;

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
        `Tracked job ${job.id} exceeded the ${formatTimeoutHuman(timeoutMs)} hard timeout; the job record was marked failed. The underlying runner was not cancelled and may still be executing in the background — kill it manually if it keeps consuming resources.`
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
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
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
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    const failurePatch = {
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      ...(timedOut ? { timedOut: true } : {})
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
    // disappear.
    if (!result.applied && result.stored === null) {
      writeJobFile(job.workspaceRoot, job.id, {
        ...runningRecord,
        ...failurePatch,
        logFile: options.logFile ?? job.logFile ?? runningRecord.logFile ?? null
      });
      upsertJob(job.workspaceRoot, { id: job.id, ...failurePatch });
    }
    throw error;
  }
}

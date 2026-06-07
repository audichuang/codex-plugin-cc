import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProcessAlive } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function nowIso() {
  return new Date().toISOString();
}

// Write a file atomically: write to a unique temp file in the same directory,
// then rename it into place (rename is atomic on POSIX/NTFS within a dir). This
// guarantees a concurrent reader never observes a half-written state.json /
// per-job record / .done signal. It does NOT serialize concurrent writers — two
// processes can still last-write-wins the whole-file index; see saveState.
let atomicWriteCounter = 0;
function atomicWriteFileSync(filePath, data) {
  atomicWriteCounter += 1;
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${atomicWriteCounter}.tmp`
  );
  fs.writeFileSync(tmp, data, "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best effort: the rename failed, so the temp is the only orphan.
    }
    throw error;
  }
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  const sorted = [...jobs].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
  // NEVER prune an active (queued/running) job: saveState deletes the per-job
  // files of any job dropped from the index, and the watchdog reads those files
  // to keep a hung/live background job alive. Evicting an active job by a stale
  // updatedAt would destroy the last liveness backstop. Keep all active jobs
  // (even beyond MAX_JOBS) and fill the remaining budget with the newest
  // terminal jobs.
  const isActive = (job) => job.status === "queued" || job.status === "running";
  const active = sorted.filter(isActive);
  const terminal = sorted.filter((job) => !isActive(job));
  const terminalBudget = Math.max(0, MAX_JOBS - active.length);
  return [...active, ...terminal.slice(0, terminalBudget)];
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
    removeFileIfExists(resolveJobDoneFile(cwd, job.id));
    removeFileIfExists(resolveJobLockFile(cwd, job.id));
  }

  // Atomic write so a concurrent reader never sees a torn index. NOTE: this does
  // not prevent a cross-process lost update — two processes that each loadState,
  // mutate a different job, then write will clobber each other's whole-array
  // snapshot. The per-job files remain the source of truth; the index is a cache
  // rebuilt on every write. Eliminating the lost update would need a
  // workspace-level lock (deliberately out of scope here).
  atomicWriteFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

function normalizeTrackedPid(pidValue) {
  const pid = Number(pidValue);
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  return Math.trunc(pid);
}

function defaultActivePredicate(stored) {
  return stored?.status === "queued" || stored?.status === "running";
}

// True only when an existing .lock is stale: its owner process is gone AND the
// per-job record is still active (the previous claimer crashed after creating
// the lock but before writing the terminal record). A finalized job legitimately
// keeps its lock, so we never reclaim once the per-job record is terminal. An
// unreadable/legacy lock (no recoverable owner pid) is treated as NOT stale —
// safer to refuse the claim than to risk stealing a live one.
function isStaleTerminalClaim(cwd, jobId, lockFile) {
  let ownerPid = null;
  try {
    ownerPid = normalizeTrackedPid(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid);
  } catch {
    return false;
  }
  if (ownerPid === null || isProcessAlive(ownerPid)) {
    return false;
  }
  let stored;
  try {
    stored = readJobFile(resolveJobFile(cwd, jobId));
  } catch {
    return false;
  }
  return defaultActivePredicate(stored);
}

// Cross-process CAS for a job's terminal transition. The first process to
// atomically create the per-job .lock (O_CREAT | O_EXCL) wins and may write the
// terminal record; a racing writer in another process gets EEXIST and returns
// false, so two processes can never both finalize the same job. The lock records
// the owner pid so a claim left behind by a CRASHED owner (dead pid + job still
// active) can be reclaimed instead of wedging the job forever. Returns true if
// this process won the claim. Exported so the recreate fallbacks (per-job file
// pruned mid-run) go through the same CAS instead of writing terminal records
// unguarded.
export function claimTerminalTransition(cwd, jobId, status, stamp) {
  const lockFile = resolveJobLockFile(cwd, jobId);
  const payload = `${JSON.stringify({ status, stamp, pid: process.pid })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      try {
        fs.writeSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (attempt === 0 && isStaleTerminalClaim(cwd, jobId, lockFile)) {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // Lost the unlink race to another reclaimer; fall through to retry/EEXIST.
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

/**
 * Atomically transitions a job record. Reads the per-job JSON, verifies the
 * job is still in an active status (queued/running), optionally runs an
 * `extraGuard` for stricter checks (e.g. PID identity), and only if ALL
 * gates pass writes the patch to both the per-job file and the state.json
 * index. Because all fs operations here are synchronous the whole
 * read-check-write sequence cannot interleave with another async writer in
 * the same process, so timeout catch, dead-PID reconcile, and progress
 * updates cannot clobber each other's metadata within one Node process.
 *
 * Across PROCESSES the active-state gate alone is not enough (two processes can
 * both read the job as active before either writes), so a TERMINAL transition
 * additionally wins a per-job O_EXCL claim file: the first process to create it
 * may write the terminal record; a racing process gets EEXIST and returns
 * `applied:false`. This makes "first terminal writer wins" hold across the
 * worker, watchdog, cancel handler, and dead-PID reconcile.
 *
 * The active-state gate ALWAYS runs — callers cannot bypass it. `extraGuard`
 * is an additional check on top of it. This prevents a future caller from
 * accidentally widening the helper past terminal-state protection.
 *
 * `patchOrBuilder` may be a plain object or a function receiving the stored
 * job that returns the patch. Return `null`/`undefined`/`false` from the
 * builder to skip the write (useful when the stored state already matches).
 *
 * `indexPatchOrBuilder` (optional) lets a caller write a LIGHTER patch to the
 * `state.json` index than to the per-job file. This keeps the index small
 * (e.g. the success path stores `result`/`rendered` in the per-job file but
 * not in the index). When omitted, the same patch goes to both (back-compat).
 *
 * Returns `{ applied, stored, patch }`. `stored` is the persisted record
 * that was read (useful for reading log paths or prior metadata without
 * reopening the file). `patch` is what was actually written to the per-job
 * file, including the `updatedAt` timestamp the helper stamps.
 */
export function applyJobPatchIfActive(cwd, jobId, patchOrBuilder, extraGuard = null, indexPatchOrBuilder = null) {
  const jobFile = resolveJobFile(cwd, jobId);
  let stored;
  try {
    stored = readJobFile(jobFile);
  } catch {
    return { applied: false, stored: null, patch: null };
  }

  if (!defaultActivePredicate(stored)) {
    return { applied: false, stored, patch: null };
  }
  if (extraGuard && !extraGuard(stored)) {
    return { applied: false, stored, patch: null };
  }

  const rawPatch =
    typeof patchOrBuilder === "function" ? patchOrBuilder(stored) : patchOrBuilder;
  if (!rawPatch) {
    return { applied: false, stored, patch: null };
  }

  const updatedAt = nowIso();
  const patch = { ...rawPatch, updatedAt };
  const isTerminalTransition = Boolean(patch.status && TERMINAL_STATUSES.has(patch.status));

  // The active-state gate above only serializes writers within THIS process.
  // For a terminal transition, additionally win a cross-process O_EXCL claim so
  // a worker, watchdog, cancel, and dead-PID reconcile in separate processes
  // cannot all finalize the same job. Progress/non-terminal patches are not
  // gated — they may legitimately repeat.
  if (isTerminalTransition && !claimTerminalTransition(cwd, jobId, patch.status, updatedAt)) {
    return { applied: false, stored, patch: null };
  }

  try {
    writeJobFile(cwd, jobId, { ...stored, ...patch });

    if (indexPatchOrBuilder == null) {
      upsertJob(cwd, { id: jobId, ...patch });
    } else {
      const indexRaw =
        typeof indexPatchOrBuilder === "function" ? indexPatchOrBuilder(stored) : indexPatchOrBuilder;
      upsertJob(cwd, { id: jobId, ...indexRaw, updatedAt });
    }
  } catch (error) {
    if (isTerminalTransition) {
      // We won the claim but failed to persist; release it so a later attempt
      // can still finalize the job instead of wedging behind a stale lock.
      try {
        fs.unlinkSync(resolveJobLockFile(cwd, jobId));
      } catch {
        // Best effort.
      }
    }
    throw error;
  }

  return { applied: true, stored, patch };
}

function reconcileDeadPidJobs(cwd, jobs) {
  const deadCandidates = [];
  for (const job of jobs) {
    // Reconcile any active state with a tracked PID. Background launches
    // persist `queued` records carrying the detached worker's child.pid
    // before `runTrackedJob` promotes them to `running`; if the worker
    // dies in that window, a `queued`-only check would leave the job
    // stuck forever and permanently block all future /codex:rescue runs
    // because the active-job guard in codex-companion.mjs treats queued
    // as active.
    if (job?.status !== "running" && job?.status !== "queued") continue;
    const pid = normalizeTrackedPid(job.pid);
    if (pid === null) continue;
    if (isProcessAlive(pid)) continue;
    deadCandidates.push({ id: job.id, pid });
  }

  if (deadCandidates.length === 0) {
    return jobs;
  }

  const completedAt = nowIso();
  const applied = new Map();

  for (const { id, pid } of deadCandidates) {
    const result = applyJobPatchIfActive(
      cwd,
      id,
      () => ({
        status: "failed",
        phase: "failed",
        pid: null,
        errorMessage: `Worker process PID ${pid} exited without reporting a terminal status; auto-reconciled as failed.`,
        completedAt,
        autoReconciled: true,
        reconciledDeadPid: pid
      }),
      // Active-state check runs first inside the helper; this extra guard
      // enforces PID identity. If the persisted PID no longer matches the
      // one we observed as dead (job re-spawned with a new PID, or OS
      // recycled the PID to an unrelated process), reconcile skips.
      (stored) => normalizeTrackedPid(stored.pid) === pid
    );

    if (!result.applied) continue;

    applied.set(id, result.patch);

    // Emit the terminal signal so a monitor waiting on <jobId>.done wakes, and
    // so the watchdog (which sees this job as already terminal) does not exit
    // leaving the signal unwritten.
    writeCompletionSignalFile(cwd, id, {
      status: "failed",
      reason: `Worker process PID ${pid} exited without reporting a terminal status; auto-reconciled as failed.`
    });

    // Human-visible marker in the job log so the next /codex:status renders
    // something explanatory in the progress preview instead of going silent.
    const logTarget = result.stored?.logFile ?? null;
    if (logTarget) {
      try {
        fs.appendFileSync(
          logTarget,
          `[${completedAt}] Auto-reconciled: worker process PID ${pid} exited without reporting a terminal status. Job marked failed.\n`,
          "utf8"
        );
      } catch {
        // Best effort; never let logging failures crash status reads.
      }
    }
  }

  if (applied.size === 0) {
    return jobs;
  }

  return jobs.map((job) => {
    const patch = applied.get(job.id);
    return patch ? { ...job, ...patch } : job;
  });
}

export function listJobs(cwd) {
  return reconcileDeadPidJobs(cwd, loadState(cwd).jobs);
}

// True when the workspace has at least one still-active background job. Used to
// keep the shared per-workspace broker alive at SessionEnd: a background job that
// outlives its session must not have the broker (its app-server) reaped out from
// under it.
export function hasActiveBackgroundJobs(cwd) {
  return listJobs(cwd).some(
    (job) => job.background === true && (job.status === "queued" || job.status === "running")
  );
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  atomicWriteFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

// Resolve a per-job file from an ALREADY-KNOWN physical state dir, without
// re-deriving it from a workspace path. Used when a job was located across
// workspaces (its physical dir may not match the slug-hash a re-derivation
// from job.workspaceRoot under the current CLAUDE_PLUGIN_DATA would produce).
export function resolveJobFileInStateDir(stateDir, jobId) {
  return path.join(stateDir, JOBS_DIR_NAME, `${jobId}.json`);
}

// All plausible state-root directories whose per-workspace subdirs may hold jobs:
// the active CLAUDE_PLUGIN_DATA/state, the $TMPDIR fallback, and every
// ~/.claude/plugins/data/codex-*/state. Only existing roots are returned. Used to
// locate a job id given in one workspace from a command run in another.
export function collectCandidateStateRoots(cwd, options = {}) {
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();
  const roots = new Set();

  const pluginDataDir = env[PLUGIN_DATA_ENV];
  if (pluginDataDir) {
    roots.add(path.join(pluginDataDir, "state"));
  }
  roots.add(FALLBACK_STATE_ROOT_DIR);

  if (homedir) {
    const pluginsData = path.join(homedir, ".claude", "plugins", "data");
    try {
      for (const entry of fs.readdirSync(pluginsData, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.toLowerCase().startsWith("codex")) {
          roots.add(path.join(pluginsData, entry.name, "state"));
        }
      }
    } catch {
      // ~/.claude/plugins/data may not exist — fine.
    }
  }

  return [...roots].filter((root) => {
    try {
      return fs.existsSync(root);
    } catch {
      return false;
    }
  });
}

// Locate a job by its EXACT id across all candidate workspace state dirs. Used
// ONLY as a fallback when an explicit job id is not found in the current
// workspace; the default (no id) selection stays workspace/session-scoped to
// avoid cross-workspace mis-selection.
export function findJobByIdAcrossWorkspaces(cwd, jobId, options = {}) {
  if (!jobId) {
    return null;
  }
  for (const stateRoot of collectCandidateStateRoots(cwd, options)) {
    let workspaceDirs;
    try {
      workspaceDirs = fs.readdirSync(stateRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of workspaceDirs) {
      if (!entry.isDirectory()) {
        continue;
      }
      const workspaceStateDir = path.join(stateRoot, entry.name);
      const jobFile = path.join(workspaceStateDir, JOBS_DIR_NAME, `${jobId}.json`);
      let job = null;
      try {
        job = readJobFile(jobFile); // throws ENOENT when absent, or on malformed JSON
      } catch {
        continue;
      }
      if (job && job.id === jobId) {
        return { job, workspaceStateDir };
      }
    }
  }
  return null;
}

export function resolveJobDoneFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.done`);
}

// One-shot terminal-claim marker for a job (see claimTerminalTransition). Its
// atomic O_EXCL creation is the cross-process "first terminal writer wins" gate.
export function resolveJobLockFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.lock`);
}

/**
 * Writes a terminal "done" signal file for a job. A monitor (the Claude-side
 * `until [ -f signalFile ]` loop, or the detached watchdog) tails this file to
 * learn that a background job has reached a terminal state, so a completed or
 * failed job surfaces instead of leaving the caller waiting forever. The
 * payload mirrors the job record's terminal status plus a human-readable
 * reason for failures.
 */
export function writeCompletionSignalFile(cwd, jobId, signal = {}) {
  const doneFile = resolveJobDoneFile(cwd, jobId);
  const payload = {
    status: signal.status ?? "completed",
    reason: signal.reason ?? null,
    signaledAt: nowIso()
  };
  atomicWriteFileSync(doneFile, `${JSON.stringify(payload, null, 2)}\n`);
  return doneFile;
}

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

function nowIso() {
  return new Date().toISOString();
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
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
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
  }

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
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
 * The active-state gate ALWAYS runs — callers cannot bypass it. `extraGuard`
 * is an additional check on top of it. This prevents a future caller from
 * accidentally widening the helper past terminal-state protection.
 *
 * `patchOrBuilder` may be a plain object or a function receiving the stored
 * job that returns the patch. Return `null`/`undefined`/`false` from the
 * builder to skip the write (useful when the stored state already matches).
 *
 * Returns `{ applied, stored, patch }`. `stored` is the persisted record
 * that was read (useful for reading log paths or prior metadata without
 * reopening the file). `patch` is what was actually written, including the
 * `updatedAt` timestamp the helper stamps on the index.
 */
export function applyJobPatchIfActive(cwd, jobId, patchOrBuilder, extraGuard = null) {
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

  writeJobFile(cwd, jobId, { ...stored, ...patch });
  upsertJob(cwd, { id: jobId, ...patch });

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
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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

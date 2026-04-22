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
 * Atomically transitions a job record guarded by a predicate on its current
 * persisted state. Reads the per-job JSON, checks the predicate, and only if
 * it passes writes the patch to both the per-job file and the state.json
 * index. Because all fs operations here are synchronous the whole
 * read-check-write sequence cannot interleave with another async writer in
 * the same process, so two writers aiming at the same job (timeout catch,
 * dead-PID reconcile, progress updater) cannot clobber each other's metadata.
 *
 * `patchOrBuilder` may be a plain object or a function that receives the
 * currently-stored job and returns the patch to apply.
 * `predicate` defaults to "status is still active"; callers that need tighter
 * guards (e.g. PID identity) can pass their own.
 *
 * Returns `{ applied, stored, patch }`. `stored` is the persisted record
 * that was read (useful for callers that want to read log paths or prior
 * metadata without re-opening the file).
 */
export function applyJobPatchIfActive(cwd, jobId, patchOrBuilder, predicate = null) {
  const jobFile = resolveJobFile(cwd, jobId);
  let stored;
  try {
    stored = readJobFile(jobFile);
  } catch {
    return { applied: false, stored: null, patch: null };
  }

  const check = predicate ?? defaultActivePredicate;
  if (!check(stored)) {
    return { applied: false, stored, patch: null };
  }

  const patch =
    typeof patchOrBuilder === "function" ? patchOrBuilder(stored) : patchOrBuilder;
  if (!patch) {
    return { applied: false, stored, patch: null };
  }

  writeJobFile(cwd, jobId, { ...stored, ...patch });
  upsertJob(cwd, { id: jobId, ...patch });

  return { applied: true, stored, patch };
}

function reconcileDeadPidJobs(cwd, jobs) {
  const deadCandidates = [];
  for (const job of jobs) {
    if (job?.status !== "running") continue;
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
      (stored) =>
        defaultActivePredicate(stored) &&
        // PID identity guard: only overwrite if the persisted PID is still
        // the one we observed as dead. If the job was re-spawned with a new
        // PID, or the OS recycled PID to an unrelated process, this fails
        // and we leave the record alone.
        normalizeTrackedPid(stored.pid) === pid
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

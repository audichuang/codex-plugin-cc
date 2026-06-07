import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { makeTempDir } from "./helpers.mjs"; // hermetic env + fs isolation
import { saveState, loadState, resolveJobFile, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

// Regression (Codex deep-review BLOCKER): pruneJobs sorted by updatedAt and kept
// only the newest MAX_JOBS, so a still-active (queued/running) job with a stale
// updatedAt could be evicted from the index — and saveState then DELETES the
// evicted job's per-job JSON/log/.done/.lock. That destroys the watchdog's view
// of a live/hung background job (it reads the per-job file), removing the last
// liveness backstop. Active jobs must NEVER be pruned.

const MAX_JOBS = 50;

test("saveState never prunes an active job, even with a stale updatedAt and a full index", () => {
  const cwd = makeTempDir();

  // The active job updated long ago (oldest), so a newest-first prune would evict it.
  const activeJob = {
    id: "job-active",
    status: "running",
    pid: process.pid,
    updatedAt: "2000-01-01T00:00:00.000Z",
    logFile: null
  };
  // Persist its per-job file AND seed it into the index, so the later flood
  // exercises saveState's eviction-deletion path (it deletes files of jobs that
  // were in the previous index but dropped from the new one).
  writeJobFile(cwd, activeJob.id, activeJob);
  saveState(cwd, { jobs: [activeJob] });

  // Fill the index past MAX_JOBS with NEWER terminal jobs.
  const terminalJobs = [];
  for (let i = 0; i < MAX_JOBS + 5; i += 1) {
    terminalJobs.push({
      id: `job-done-${i}`,
      status: "completed",
      pid: null,
      updatedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      logFile: null
    });
  }

  saveState(cwd, { jobs: [activeJob, ...terminalJobs] });

  const reloaded = loadState(cwd);
  const stillIndexed = reloaded.jobs.some((j) => j.id === "job-active");
  assert.ok(stillIndexed, "an active (running) job must be retained in the index, not pruned by updatedAt");
  assert.ok(
    fs.existsSync(resolveJobFile(cwd, "job-active")),
    "an active job's per-job file must not be deleted (the watchdog reads it)"
  );
});

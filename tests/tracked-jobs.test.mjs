import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  resolveJobFile,
  resolveJobLogFile,
  resolveStateFile,
  saveState,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { createJobProgressUpdater } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

function seedJob(workspace, overrides) {
  const jobId = overrides.id ?? "task-progress";
  const job = {
    id: jobId,
    status: "running",
    phase: "starting",
    pid: process.pid,
    logFile: resolveJobLogFile(workspace, jobId),
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
  writeJobFile(workspace, jobId, job);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });
  return job;
}

test("createJobProgressUpdater writes a phase patch while the job is active", () => {
  const workspace = makeTempDir();
  const job = seedJob(workspace, { id: "task-prog-active" });

  const update = createJobProgressUpdater(workspace, job.id);
  update({ message: "", phase: "investigating" });

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
  assert.equal(persisted.phase, "investigating");

  const indexed = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
  assert.equal(indexed.jobs[0].phase, "investigating");
});

test("createJobProgressUpdater drops late progress events after the job reached a terminal state", () => {
  // Regression for Codex review finding #4: after runTrackedJob wrote
  // status:"failed" via the hard-timeout path, a late progress event from
  // the still-running runner must not clobber phase/updatedAt.
  const workspace = makeTempDir();
  const job = seedJob(workspace, {
    id: "task-prog-terminal",
    status: "failed",
    phase: "failed",
    timedOut: true,
    errorMessage: "timed out"
  });

  const update = createJobProgressUpdater(workspace, job.id);
  update({ message: "", phase: "editing", turnId: "t-late-1" });

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
  assert.equal(persisted.phase, "failed", "terminal phase must not be overwritten");
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.turnId, undefined, "should not inject a new turnId onto a terminal record");
  assert.equal(persisted.errorMessage, "timed out");

  const indexed = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
  assert.equal(indexed.jobs[0].phase, "failed");
  assert.equal(indexed.jobs[0].turnId ?? null, null);
});

test("createJobProgressUpdater ignores events that do not change any tracked field", () => {
  const workspace = makeTempDir();
  const job = seedJob(workspace, { id: "task-prog-noop", phase: "investigating" });

  const update = createJobProgressUpdater(workspace, job.id);
  // Same phase twice in a row; second call is a no-op.
  update({ message: "", phase: "investigating" });
  const before = fs.readFileSync(resolveJobFile(workspace, job.id), "utf8");
  update({ message: "", phase: "investigating" });
  const after = fs.readFileSync(resolveJobFile(workspace, job.id), "utf8");

  assert.equal(before, after);
});

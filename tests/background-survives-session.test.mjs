import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  loadState,
  saveState,
  writeJobFile,
  resolveJobFile,
  resolveJobDoneFile,
  hasActiveBackgroundJobs
} from "../plugins/codex/scripts/lib/state.mjs";
import { enqueueBackgroundTask } from "../plugins/codex/scripts/codex-companion.mjs";
import { cleanupSessionJobs, shouldTeardownBroker } from "../plugins/codex/scripts/session-lifecycle-hook.mjs";

function seed(workspace, jobs) {
  for (const job of jobs) {
    writeJobFile(workspace, job.id, job);
  }
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs });
}

const bgJob = (overrides) => ({
  id: "bg-1",
  sessionId: "S1",
  status: "running",
  phase: "investigating",
  pid: 999_999,
  background: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides
});

test("enqueueBackgroundTask marks the job record as background", () => {
  const workspace = makeTempDir();
  const job = { id: "task-bg", workspaceRoot: workspace, title: "Codex task", summary: "do x" };
  enqueueBackgroundTask(workspace, job, { kind: "task" }, {
    spawnWorker: () => ({ pid: 4321 }),
    spawnWatchdog: () => ({ pid: 4322 })
  });
  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, "task-bg"), "utf8"));
  assert.equal(record.background, true);
});

test("cleanupSessionJobs leaves an active background job running and in the index", () => {
  const workspace = makeTempDir();
  seed(workspace, [bgJob()]);

  cleanupSessionJobs(workspace, "S1");

  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, "bg-1"), "utf8"));
  assert.equal(record.status, "running", "a background job must not be terminated at session end");
  assert.equal(fs.existsSync(resolveJobDoneFile(workspace, "bg-1")), false, "no .done signal for a surviving job");

  const state = loadState(workspace);
  assert.equal(state.jobs.some((j) => j.id === "bg-1"), true, "the surviving job stays in the index for the parent session's status");
});

test("cleanupSessionJobs still terminates a foreground (non-background) session job", () => {
  const workspace = makeTempDir();
  seed(workspace, [bgJob({ id: "fg-1", background: false })]);

  cleanupSessionJobs(workspace, "S1");

  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, "fg-1"), "utf8"));
  assert.equal(record.status, "failed");
  assert.equal(record.endedBySession, true);
});

test("hasActiveBackgroundJobs detects an active background job (live worker pid)", () => {
  const workspace = makeTempDir();
  // listJobs reconciles dead-pid running jobs to failed, so an "active" job needs
  // a live worker pid — use this test process's pid as a stand-in.
  seed(workspace, [bgJob({ pid: process.pid })]);
  assert.equal(hasActiveBackgroundJobs(workspace), true);
});

test("hasActiveBackgroundJobs is false when the background worker pid is dead (reconciled)", () => {
  const workspace = makeTempDir();
  seed(workspace, [bgJob({ pid: 2_147_483_646 })]); // a pid that never exists
  assert.equal(hasActiveBackgroundJobs(workspace), false, "a dead-worker background job is not active; the broker may be reaped");
});

test("hasActiveBackgroundJobs is false when background jobs are terminal or absent", () => {
  const workspace = makeTempDir();
  seed(workspace, [bgJob({ status: "completed", phase: "done" }), bgJob({ id: "fg", background: false, status: "running" })]);
  assert.equal(hasActiveBackgroundJobs(workspace), false);
});

test("shouldTeardownBroker only tears down when not busy AND no active background jobs", () => {
  assert.equal(shouldTeardownBroker({ busy: false }, false), true);
  assert.equal(shouldTeardownBroker({ busy: true }, false), false, "busy broker is never torn down");
  assert.equal(shouldTeardownBroker({ busy: false }, true), false, "active background job keeps the shared broker alive");
  assert.equal(shouldTeardownBroker({ busy: true }, true), false);
});

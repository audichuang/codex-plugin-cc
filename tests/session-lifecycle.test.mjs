import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  loadState,
  resolveJobDoneFile,
  resolveJobFile,
  saveState,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { cleanupSessionJobs } from "../plugins/codex/scripts/session-lifecycle-hook.mjs";

function seed(workspace, jobs) {
  for (const job of jobs) {
    writeJobFile(workspace, job.id, job);
  }
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs });
}

test("cleanupSessionJobs marks a running session job failed and writes a .done signal", () => {
  const workspace = makeTempDir();
  const job = {
    id: "job-run",
    sessionId: "S1",
    status: "running",
    phase: "investigating",
    pid: 999_999,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  seed(workspace, [job]);

  cleanupSessionJobs(workspace, "S1");

  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, "job-run"), "utf8"));
  assert.equal(record.status, "failed");
  assert.equal(record.endedBySession, true);
  assert.match(record.errorMessage ?? "", /session ended/i);

  const doneFile = resolveJobDoneFile(workspace, "job-run");
  assert.equal(fs.existsSync(doneFile), true);
  assert.equal(JSON.parse(fs.readFileSync(doneFile, "utf8")).status, "failed");

  // The failed job is retained so /codex:result can surface it.
  const state = loadState(workspace);
  assert.equal(state.jobs.some((j) => j.id === "job-run" && j.status === "failed"), true);
});

test("cleanupSessionJobs removes terminal session jobs", () => {
  const workspace = makeTempDir();
  seed(workspace, [
    {
      id: "job-done",
      sessionId: "S1",
      status: "completed",
      phase: "done",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  ]);

  cleanupSessionJobs(workspace, "S1");

  const state = loadState(workspace);
  assert.equal(state.jobs.some((j) => j.id === "job-done"), false);
});

test("cleanupSessionJobs leaves other sessions' jobs untouched", () => {
  const workspace = makeTempDir();
  seed(workspace, [
    {
      id: "job-other",
      sessionId: "S2",
      status: "running",
      phase: "investigating",
      pid: 999_999,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  ]);

  cleanupSessionJobs(workspace, "S1");

  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, "job-other"), "utf8"));
  assert.equal(record.status, "running");
  assert.equal(fs.existsSync(resolveJobDoneFile(workspace, "job-other")), false);
});

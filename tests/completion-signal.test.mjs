import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  resolveJobDoneFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobsDir,
  resolveStateFile,
  saveState,
  writeCompletionSignalFile
} from "../plugins/codex/scripts/lib/state.mjs";

test("resolveJobDoneFile points at <jobId>.done inside the jobs dir", () => {
  const workspace = makeTempDir();
  const doneFile = resolveJobDoneFile(workspace, "job-x");
  assert.equal(path.dirname(doneFile), resolveJobsDir(workspace));
  assert.equal(path.basename(doneFile), "job-x.done");
});

test("writeCompletionSignalFile writes a terminal signal with status and reason", () => {
  const workspace = makeTempDir();
  const doneFile = writeCompletionSignalFile(workspace, "job-x", {
    status: "failed",
    reason: "watchdog: no events for 16m"
  });

  assert.equal(doneFile, resolveJobDoneFile(workspace, "job-x"));
  assert.equal(fs.existsSync(doneFile), true);

  const payload = JSON.parse(fs.readFileSync(doneFile, "utf8"));
  assert.equal(payload.status, "failed");
  assert.equal(payload.reason, "watchdog: no events for 16m");
  assert.match(payload.signaledAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("writeCompletionSignalFile defaults status to completed and reason to null", () => {
  const workspace = makeTempDir();
  const doneFile = writeCompletionSignalFile(workspace, "job-y", {});
  const payload = JSON.parse(fs.readFileSync(doneFile, "utf8"));

  assert.equal(payload.status, "completed");
  assert.equal(payload.reason, null);
});

test("saveState prunes the .done signal file for dropped jobs", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    writeCompletionSignalFile(workspace, jobId, { status: "completed" });
    return { id: jobId, status: "completed", logFile, updatedAt, createdAt: updatedAt };
  });

  // saveState prunes by diffing against the previously-persisted index, so the
  // jobs must be on disk before the prune pass runs.
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs }, null, 2)}\n`,
    "utf8"
  );

  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs });

  // job-0 is the oldest and is pruned past the 50-job cap; job-50 is retained.
  assert.equal(fs.existsSync(resolveJobDoneFile(workspace, "job-0")), false);
  assert.equal(fs.existsSync(resolveJobDoneFile(workspace, "job-50")), true);
});

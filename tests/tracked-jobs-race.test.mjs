import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  applyJobPatchIfActive,
  resolveJobDoneFile,
  resolveJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

test("runTrackedJob does not resurrect a job an external actor already marked terminal", async () => {
  const workspace = makeTempDir();
  const jobId = "job-reverse-race";

  // The runner resolves successfully, but BEFORE it returns, an external actor
  // (watchdog / dead-PID reconcile) wins and marks the job failed. The success
  // branch must not overwrite that terminal state back to "completed".
  const runner = async () => {
    applyJobPatchIfActive(workspace, jobId, () => ({
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage: "killed by watchdog mid-flight"
    }));
    return { exitStatus: 0, payload: {}, rendered: "late success", summary: "late" };
  };

  await runTrackedJob({ id: jobId, workspaceRoot: workspace }, runner, {});

  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(record.status, "failed", "the external terminal status must win, not be resurrected");

  const doneFile = resolveJobDoneFile(workspace, jobId);
  if (fs.existsSync(doneFile)) {
    assert.notEqual(
      JSON.parse(fs.readFileSync(doneFile, "utf8")).status,
      "completed",
      "must not write a completed signal over an externally-failed job"
    );
  }
});

test("runTrackedJob still writes the completed record + signal on the normal success path", async () => {
  const workspace = makeTempDir();
  const jobId = "job-normal-success";

  await runTrackedJob(
    { id: jobId, workspaceRoot: workspace },
    async () => ({ exitStatus: 0, payload: { ok: 1 }, rendered: "done", summary: "done" }),
    {}
  );

  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(record.status, "completed");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobDoneFile(workspace, jobId), "utf8")).status, "completed");
});

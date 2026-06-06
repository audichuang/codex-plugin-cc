import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  applyJobPatchIfActive,
  loadState,
  resolveJobDoneFile,
  resolveJobFile,
  upsertJob,
  writeCompletionSignalFile
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

test("runTrackedJob failure path does not overwrite a terminal .done written by another actor", async () => {
  const workspace = makeTempDir();
  const jobId = "job-fail-race";

  // An external actor (e.g. user /codex:cancel) finalizes the job and writes
  // its terminal signal; THEN the runner errors. The catch path's CAS loses
  // (job no longer active), so it must not stomp the cancelled signal with one
  // that says "failed".
  const runner = async () => {
    applyJobPatchIfActive(workspace, jobId, () => ({ status: "cancelled", phase: "cancelled", pid: null }));
    writeCompletionSignalFile(workspace, jobId, { status: "cancelled", reason: "Cancelled by user." });
    throw new Error("runner errored after an external cancel");
  };

  await assert.rejects(runTrackedJob({ id: jobId, workspaceRoot: workspace }, runner, {}));

  const done = JSON.parse(fs.readFileSync(resolveJobDoneFile(workspace, jobId), "utf8"));
  assert.equal(done.status, "cancelled", "the externally-written terminal signal must not be overwritten");
  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(record.status, "cancelled");
});

test("runTrackedJob still writes a failed signal on a normal (no-race) failure", async () => {
  const workspace = makeTempDir();
  const jobId = "job-fail-normal";
  await assert.rejects(
    runTrackedJob({ id: jobId, workspaceRoot: workspace }, async () => {
      throw new Error("boom");
    }, {})
  );
  assert.equal(JSON.parse(fs.readFileSync(resolveJobDoneFile(workspace, jobId), "utf8")).status, "failed");
});

test("runTrackedJob still records completion + signal if the per-job file was pruned mid-run", async () => {
  const workspace = makeTempDir();
  const jobId = "job-pruned-success";

  // Simulate the per-job file being pruned (e.g. >50 newer jobs appeared) while
  // a silent long-running job was still alive, then the runner succeeds. The
  // success path must recreate the terminal record + .done (mirror of the
  // failure-path fallback) so a monitor does not hang.
  const runner = async () => {
    fs.rmSync(resolveJobFile(workspace, jobId), { force: true });
    return { exitStatus: 0, payload: { ok: 1 }, rendered: "done", summary: "done" };
  };

  await runTrackedJob({ id: jobId, workspaceRoot: workspace }, runner, {});

  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(record.status, "completed");
  assert.equal(record.rendered, "done");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobDoneFile(workspace, jobId), "utf8")).status, "completed");
});

test("runTrackedJob success path does not clobber an index terminal record when the per-job file was pruned", async () => {
  const workspace = makeTempDir();
  const jobId = "job-pruned-but-finalized";

  // The per-job file was pruned, but an external actor already finalized the
  // job as failed in the index AND wrote its terminal .done. A late success
  // must not resurrect it to completed: first terminal writer wins, even on
  // the stored===null fallback path.
  const runner = async () => {
    fs.rmSync(resolveJobFile(workspace, jobId), { force: true });
    upsertJob(workspace, { id: jobId, status: "failed", phase: "failed", pid: null });
    writeCompletionSignalFile(workspace, jobId, { status: "failed", reason: "finalized elsewhere" });
    return { exitStatus: 0, payload: { ok: 1 }, rendered: "late", summary: "late" };
  };

  await runTrackedJob({ id: jobId, workspaceRoot: workspace }, runner, {});

  const indexJob = loadState(workspace).jobs.find((job) => job.id === jobId);
  assert.equal(indexJob.status, "failed", "must not resurrect an index-finalized job to completed");
  assert.equal(
    JSON.parse(fs.readFileSync(resolveJobDoneFile(workspace, jobId), "utf8")).status,
    "failed",
    "must not overwrite an externally-written terminal signal"
  );
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

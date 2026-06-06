import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveJobDoneFile } from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

test("runTrackedJob writes a completed signal file on success", async () => {
  const workspace = makeTempDir();
  const job = { id: "job-ok", workspaceRoot: workspace };

  await runTrackedJob(job, async () => ({ exitStatus: 0, payload: {}, rendered: "ok", summary: "ok" }), {});

  const doneFile = resolveJobDoneFile(workspace, "job-ok");
  assert.equal(fs.existsSync(doneFile), true);
  const payload = JSON.parse(fs.readFileSync(doneFile, "utf8"));
  assert.equal(payload.status, "completed");
});

test("runTrackedJob writes a failed signal file with the error reason when the runner rejects", async () => {
  const workspace = makeTempDir();
  const job = { id: "job-fail", workspaceRoot: workspace };

  await assert.rejects(
    runTrackedJob(job, async () => {
      throw new Error("boom from runner");
    }, {})
  );

  const doneFile = resolveJobDoneFile(workspace, "job-fail");
  assert.equal(fs.existsSync(doneFile), true);
  const payload = JSON.parse(fs.readFileSync(doneFile, "utf8"));
  assert.equal(payload.status, "failed");
  assert.match(payload.reason ?? "", /boom from runner/);
});

test("runTrackedJob writes a failed signal file when the runner reports a non-zero exit", async () => {
  const workspace = makeTempDir();
  const job = { id: "job-nonzero", workspaceRoot: workspace };

  await runTrackedJob(job, async () => ({ exitStatus: 1, payload: {}, rendered: "x", summary: "x" }), {});

  const payload = JSON.parse(fs.readFileSync(resolveJobDoneFile(workspace, "job-nonzero"), "utf8"));
  assert.equal(payload.status, "failed");
});

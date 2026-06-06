import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  applyJobPatchIfActive,
  resolveJobFile,
  resolveStateFile,
  saveState,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

function seedRunning(workspace, jobId) {
  const running = {
    id: jobId,
    status: "running",
    phase: "starting",
    pid: 123,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  writeJobFile(workspace, jobId, running);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [running] });
}

test("applyJobPatchIfActive writes the full patch to the per-job file but a lighter indexPatch to state.json", () => {
  const workspace = makeTempDir();
  const jobId = "job-idx";
  seedRunning(workspace, jobId);

  const res = applyJobPatchIfActive(
    workspace,
    jobId,
    () => ({ status: "completed", phase: "done", pid: null, result: { big: "payload" }, rendered: "RENDERED" }),
    null,
    () => ({ status: "completed", phase: "done", pid: null }) // index patch: deliberately light
  );

  assert.equal(res.applied, true);

  const file = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(file.status, "completed");
  assert.deepEqual(file.result, { big: "payload" }, "per-job file keeps the heavy result");
  assert.equal(file.rendered, "RENDERED");

  const index = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8")).jobs.find((j) => j.id === jobId);
  assert.equal(index.status, "completed");
  assert.equal(index.result, undefined, "state.json index stays light: no result payload");
  assert.equal(index.rendered, undefined, "state.json index stays light: no rendered text");
});

test("applyJobPatchIfActive without an indexPatch keeps writing the same patch to both (back-compat)", () => {
  const workspace = makeTempDir();
  const jobId = "job-compat";
  seedRunning(workspace, jobId);

  applyJobPatchIfActive(workspace, jobId, () => ({ status: "failed", phase: "failed", pid: null, errorMessage: "x" }));

  const index = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8")).jobs.find((j) => j.id === jobId);
  assert.equal(index.status, "failed");
  assert.equal(index.errorMessage, "x", "no indexPatch => index receives the same patch as before");
});

test("applyJobPatchIfActive still gates on active state when an indexPatch is supplied", () => {
  const workspace = makeTempDir();
  const jobId = "job-terminal";
  const done = {
    id: jobId,
    status: "failed",
    phase: "failed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  writeJobFile(workspace, jobId, done);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [done] });

  const res = applyJobPatchIfActive(
    workspace,
    jobId,
    () => ({ status: "completed", result: { x: 1 } }),
    null,
    () => ({ status: "completed" })
  );
  assert.equal(res.applied, false, "a terminal job is never resurrected, indexPatch or not");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8")).status, "failed");
});

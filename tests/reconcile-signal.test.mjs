import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  listJobs,
  resolveJobDoneFile,
  saveState,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

// A pid that is effectively never a live process, so dead-PID reconcile fires.
const DEAD_PID = 2_147_483_646;

test("dead-PID reconcile writes a .done signal so a waiting monitor wakes", () => {
  const workspace = makeTempDir();
  const job = {
    id: "job-deadpid",
    status: "running",
    phase: "investigating",
    pid: DEAD_PID,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  writeJobFile(workspace, "job-deadpid", job);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });

  const reconciled = listJobs(workspace);
  assert.equal(reconciled.find((j) => j.id === "job-deadpid").status, "failed");

  const doneFile = resolveJobDoneFile(workspace, "job-deadpid");
  assert.equal(fs.existsSync(doneFile), true);
  const payload = JSON.parse(fs.readFileSync(doneFile, "utf8"));
  assert.equal(payload.status, "failed");
  assert.match(payload.reason ?? "", /exited|reconciled/i);
});

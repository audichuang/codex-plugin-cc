import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { applyJobPatchIfActive, resolveJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

test("runTrackedJob interrupts the hung turn when the hard timeout fires", async () => {
  const workspace = makeTempDir();
  const jobId = "job-timeout";
  const calls = [];

  await assert.rejects(
    runTrackedJob(
      { id: jobId, workspaceRoot: workspace },
      async () => {
        // Simulate progress recording the active thread/turn, then hang.
        applyJobPatchIfActive(workspace, jobId, { threadId: "th-T", turnId: "tn-T" });
        await new Promise(() => {});
      },
      {
        timeoutMs: 40,
        interruptOnTimeout: async (cwd, ctx) => {
          calls.push({ cwd, ctx });
        }
      }
    ),
    /hard timeout/i
  );

  assert.equal(calls.length, 1, "interrupt should be attempted exactly once on timeout");
  assert.equal(calls[0].cwd, workspace);
  assert.deepEqual(calls[0].ctx, { threadId: "th-T", turnId: "tn-T" });

  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(record.status, "failed");
  assert.equal(record.timedOut, true);
});

test("runTrackedJob does not interrupt on a normal (non-timeout) failure", async () => {
  const workspace = makeTempDir();
  const jobId = "job-plainfail";
  const calls = [];

  await assert.rejects(
    runTrackedJob(
      { id: jobId, workspaceRoot: workspace },
      async () => {
        throw new Error("plain failure");
      },
      {
        timeoutMs: 60_000,
        interruptOnTimeout: async (cwd, ctx) => {
          calls.push({ cwd, ctx });
        }
      }
    ),
    /plain failure/
  );

  assert.equal(calls.length, 0, "a non-timeout failure must not trigger an interrupt");
});

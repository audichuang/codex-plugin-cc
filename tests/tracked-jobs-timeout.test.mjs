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

test("runTrackedJob schedules a process-tree terminate on hard timeout so the worker can exit", async () => {
  const workspace = makeTempDir();
  const jobId = "job-timeout-kill";
  const killed = [];

  await assert.rejects(
    runTrackedJob(
      { id: jobId, workspaceRoot: workspace },
      async () => {
        await new Promise(() => {}); // hang; no thread recorded, so interrupt is skipped
      },
      {
        timeoutMs: 30,
        interruptOnTimeout: async () => {},
        terminateOnTimeout: (pid) => killed.push(pid)
      }
    ),
    /hard timeout/i
  );

  // The terminate is scheduled on an unref'd macrotask; let it fire.
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(killed.length, 1, "a hard timeout should schedule exactly one terminate");
  assert.equal(killed[0], process.pid, "it terminates the worker process tree (runningRecord.pid)");
});

test("runTrackedJob does not terminate on a normal (non-timeout) failure", async () => {
  const workspace = makeTempDir();
  const killed = [];
  await assert.rejects(
    runTrackedJob(
      { id: "job-plain-noterm", workspaceRoot: workspace },
      async () => {
        throw new Error("plain failure");
      },
      { timeoutMs: 60_000, terminateOnTimeout: (pid) => killed.push(pid) }
    ),
    /plain failure/
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(killed.length, 0);
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

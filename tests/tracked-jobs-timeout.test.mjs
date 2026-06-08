import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { applyJobPatchIfActive, resolveJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob, DEFAULT_JOB_TIMEOUT_MS } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

test("the default background-job hard cap is one hour", () => {
  // A single task call can legitimately run many TDD cycles (npm/vitest/tsc),
  // so the unconditional wall-clock backstop is 1h — long enough not to cut a
  // healthy long job, short enough that a wedged background job never runs all
  // day. (The watchdog still reaps a confirmed-dead job — broker unreachable +
  // silent past hangQuietMs — in ~15 min, independent of this cap.)
  assert.equal(DEFAULT_JOB_TIMEOUT_MS, 60 * 60 * 1000);
});

test("a tracked job with no explicit timeout records the one-hour deadline", async () => {
  // helpers.mjs drops ambient CODEX_*, so CODEX_JOB_TIMEOUT_MS is unset and the
  // default applies. The runner settles immediately, so the timer never fires —
  // we only assert the deadline the running record was stamped with.
  const workspace = makeTempDir();
  const jobId = "job-default-timeout";

  await runTrackedJob({ id: jobId, workspaceRoot: workspace }, async () => "ok", {});

  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(record.timeoutMs, 60 * 60 * 1000);
});

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
        // No-op terminate seam: runTrackedJob's hard-timeout path reaps the
        // worker's own process tree (runningRecord.pid === this test process).
        // Without the seam, terminateProcessTree would now actually SIGTERM the
        // test runner (it correctly falls back to a direct kill when the pid is
        // not a group leader). This test only exercises the interrupt path.
        terminateOnTimeout: () => {},
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

test("runTrackedJob does not interrupt on timeout when only one of threadId/turnId is recorded", async () => {
  const workspace = makeTempDir();
  const jobId = "job-timeout-halfid";
  const calls = [];

  await assert.rejects(
    runTrackedJob(
      { id: jobId, workspaceRoot: workspace },
      async () => {
        // Only a threadId is recorded; interruptAppServerTurn needs both ids, so
        // the timeout path must not pretend it can interrupt.
        applyJobPatchIfActive(workspace, jobId, { threadId: "th-only" });
        await new Promise(() => {});
      },
      {
        timeoutMs: 40,
        // No-op terminate seam: runTrackedJob's hard-timeout path reaps the
        // worker's own process tree (runningRecord.pid === this test process).
        // Without the seam, terminateProcessTree would now actually SIGTERM the
        // test runner (it correctly falls back to a direct kill when the pid is
        // not a group leader). This test only exercises the interrupt path.
        terminateOnTimeout: () => {},
        interruptOnTimeout: async (cwd, ctx) => {
          calls.push({ cwd, ctx });
        }
      }
    ),
    /hard timeout/i
  );

  assert.equal(calls.length, 0, "interrupt requires both threadId and turnId");
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

test("runTrackedJob interrupts + terminates on an ETURNIDLE rejection (idle watchdog), like a hard timeout", async () => {
  const workspace = makeTempDir();
  const jobId = "job-idle";
  const calls = [];
  const killed = [];

  await assert.rejects(
    runTrackedJob(
      { id: jobId, workspaceRoot: workspace },
      async () => {
        // Progress records the active thread/turn, then the captureTurn idle
        // watchdog rejects with an ETURNIDLE-coded error (turn wedged, not hung
        // worker). This is NOT the 15-min hard cap — timeoutMs is huge below.
        applyJobPatchIfActive(workspace, jobId, { threadId: "th-IDLE", turnId: "tn-IDLE" });
        const error = new Error("Codex turn stalled: no app-server activity for 5000ms");
        error.code = "ETURNIDLE";
        error.threadId = "th-IDLE";
        error.turnId = "tn-IDLE";
        throw error;
      },
      {
        timeoutMs: 60_000, // hard cap NOT reached; the idle rejection drives remediation
        interruptOnTimeout: async (cwd, ctx) => {
          calls.push({ cwd, ctx });
        },
        terminateOnTimeout: (pid) => killed.push(pid)
      }
    ),
    /stalled|idle|activity/i
  );

  assert.equal(calls.length, 1, "an idle (ETURNIDLE) rejection must interrupt the orphan turn");
  assert.deepEqual(calls[0].ctx, { threadId: "th-IDLE", turnId: "tn-IDLE" });

  // The terminate is scheduled on an unref'd macrotask; let it fire.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(killed.length, 1, "an idle rejection must also schedule a worker terminate");

  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(record.status, "failed");
  assert.equal(record.idleTimedOut, true, "the failure record should be tagged as an idle timeout");
  assert.notEqual(record.timedOut, true, "an idle rejection is distinct from the hard-cap timeout");
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

import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs"; // hermetic env + fs isolation
import {
  resolveJobFile,
  resolveJobDoneFile,
  writeJobFile,
  applyJobPatchIfActive,
  writeCompletionSignalFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { installJobCrashNet, runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

// A worker process runs exactly one tracked job. While it is in flight, ANY
// uncaught throw / unhandled rejection (e.g. a synchronous throw from a transport
// stream `data` listener that bypasses runTrackedJob's try/catch) must become a
// RECORDED terminal failure with the real error — not a silent worker death that
// surfaces only later as the cryptic "exited without reporting a terminal status"
// dead-PID reconcile. installJobCrashNet is the last-resort net for that.
function makeFakeProc() {
  const handlers = {};
  const exits = [];
  return {
    handlers,
    exits,
    on(event, fn) {
      (handlers[event] ??= []).push(fn);
    },
    removeListener(event, fn) {
      handlers[event] = (handlers[event] ?? []).filter((h) => h !== fn);
    },
    exit(code) {
      exits.push(code);
    },
    fire(event, payload) {
      let last;
      for (const h of [...(handlers[event] ?? [])]) last = h(payload);
      return last; // the handler may be async (turn-reap path) — let callers await it
    }
  };
}

function writeRunningJob(workspace, jobId, extra = {}) {
  const record = {
    id: jobId,
    workspaceRoot: workspace,
    status: "running",
    phase: "running",
    pid: process.pid,
    logFile: null,
    ...extra
  };
  writeJobFile(workspace, jobId, record);
  return record;
}

test("installJobCrashNet finalizes the in-flight job as failed + writes .done + exits nonzero on uncaughtException", () => {
  const workspace = makeTempDir();
  const jobId = "job-crash-1";
  const running = writeRunningJob(workspace, jobId);

  const proc = makeFakeProc();
  installJobCrashNet({ id: jobId, workspaceRoot: workspace }, running, { proc });

  assert.equal((proc.handlers.uncaughtException ?? []).length, 1, "uncaughtException handler installed");
  assert.equal((proc.handlers.unhandledRejection ?? []).length, 1, "unhandledRejection handler installed");

  proc.fire("uncaughtException", new Error("kaboom-distinct-stack"));

  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(stored.status, "failed");
  assert.equal(stored.crashed, true);
  assert.match(stored.errorMessage, /kaboom-distinct-stack/);

  const done = JSON.parse(fs.readFileSync(resolveJobDoneFile(workspace, jobId), "utf8"));
  assert.equal(done.status, "failed");

  assert.deepEqual(proc.exits, [1], "the worker exits nonzero so the failure is unambiguous");
});

test("installJobCrashNet also finalizes the job on unhandledRejection", () => {
  const workspace = makeTempDir();
  const jobId = "job-crash-2";
  const running = writeRunningJob(workspace, jobId);

  const proc = makeFakeProc();
  installJobCrashNet({ id: jobId, workspaceRoot: workspace }, running, { proc });
  proc.fire("unhandledRejection", new Error("rejected-distinct-reason"));

  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(stored.status, "failed");
  assert.match(stored.errorMessage, /rejected-distinct-reason/);
  assert.deepEqual(proc.exits, [1]);
});

test("installJobCrashNet does not overwrite an already-terminal job nor stomp its .done (first-writer-wins)", () => {
  const workspace = makeTempDir();
  const jobId = "job-crash-3";
  const running = writeRunningJob(workspace, jobId);
  // Another actor (e.g. user cancel / watchdog) wins the terminal transition first.
  applyJobPatchIfActive(workspace, jobId, () => ({ status: "cancelled", phase: "cancelled", pid: null }));
  writeCompletionSignalFile(workspace, jobId, { status: "cancelled", reason: "user-cancelled-sentinel" });

  const proc = makeFakeProc();
  installJobCrashNet({ id: jobId, workspaceRoot: workspace }, running, { proc });
  proc.fire("uncaughtException", new Error("late-crash-after-cancel"));

  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(stored.status, "cancelled", "must not resurrect / overwrite a terminal job");
  const done = JSON.parse(fs.readFileSync(resolveJobDoneFile(workspace, jobId), "utf8"));
  assert.equal(done.status, "cancelled");
  assert.match(done.reason, /user-cancelled-sentinel/, "must not stomp the prior .done");
  assert.deepEqual(proc.exits, [1], "still exits nonzero — the worker is dying regardless");
});

test("installJobCrashNet best-effort interrupts the orphaned turn when threadId/turnId are known", async () => {
  const workspace = makeTempDir();
  const jobId = "job-crash-interrupt";
  // A running record carrying turn identity, as the progress updater writes it
  // onto the per-job file once turn/started arrives.
  const running = writeRunningJob(workspace, jobId, { threadId: "th-1", turnId: "tn-1" });

  const interrupts = [];
  const proc = makeFakeProc();
  installJobCrashNet(
    { id: jobId, workspaceRoot: workspace, cwd: workspace },
    running,
    {
      proc,
      interruptOnCrash: async (cwd, ctx) => {
        interrupts.push({ cwd, ctx });
      }
    }
  );

  await proc.fire("uncaughtException", new Error("crash-with-a-live-turn"));

  assert.equal(interrupts.length, 1, "the orphaned turn (which runs on the broker) is interrupted");
  assert.deepEqual(interrupts[0].ctx, { threadId: "th-1", turnId: "tn-1" });
  assert.equal(interrupts[0].cwd, workspace);

  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(stored.status, "failed", "death is still recorded before/independent of the interrupt");
  assert.deepEqual(proc.exits, [1]);
});

test("installJobCrashNet does not attempt an interrupt when the turn never started (no thread/turn id)", async () => {
  const workspace = makeTempDir();
  const jobId = "job-crash-no-turn";
  const running = writeRunningJob(workspace, jobId); // no threadId/turnId yet

  const interrupts = [];
  const proc = makeFakeProc();
  installJobCrashNet({ id: jobId, workspaceRoot: workspace }, running, {
    proc,
    interruptOnCrash: async (cwd, ctx) => {
      interrupts.push({ cwd, ctx });
    }
  });

  await proc.fire("uncaughtException", new Error("crash-before-turn-start"));

  assert.equal(interrupts.length, 0, "nothing to interrupt — gate on both ids being present");
  assert.deepEqual(proc.exits, [1]);
});

test("the disposer removes both listeners so the net never outlives the run", () => {
  const workspace = makeTempDir();
  const jobId = "job-crash-4";
  const running = writeRunningJob(workspace, jobId);

  const proc = makeFakeProc();
  const dispose = installJobCrashNet({ id: jobId, workspaceRoot: workspace }, running, { proc });
  dispose();

  assert.equal((proc.handlers.uncaughtException ?? []).length, 0);
  assert.equal((proc.handlers.unhandledRejection ?? []).length, 0);
});

test("runTrackedJob installs the crash net during the run and disposes it afterwards", async () => {
  const workspace = makeTempDir();
  const jobId = "job-wire";
  const events = [];
  const proc = {
    on: (event) => events.push(`on:${event}`),
    removeListener: (event) => events.push(`off:${event}`),
    exit: () => {}
  };

  await runTrackedJob(
    { id: jobId, workspaceRoot: workspace },
    async () => ({ exitStatus: 0, payload: {}, rendered: "ok", summary: "ok" }),
    { proc, timeoutMs: 1000 }
  );

  assert.ok(events.includes("on:uncaughtException"), "crash net installed during the run");
  assert.ok(events.includes("on:unhandledRejection"), "rejection net installed during the run");
  assert.ok(events.includes("off:uncaughtException"), "crash net disposed after the run");
  assert.ok(events.includes("off:unhandledRejection"), "rejection net disposed after the run");
});


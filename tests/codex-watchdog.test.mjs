import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  resolveJobDoneFile,
  resolveJobFile,
  resolveJobLogFile,
  saveState,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import {
  gatherObservation,
  runWatchdog,
  terminateHungJob
} from "../plugins/codex/scripts/codex-watchdog.mjs";

const CONFIG = { hangQuietMs: 900_000, hardQuietMs: 1_800_000 };

test("gatherObservation derives liveness signals from the job record and deps", async () => {
  const deps = {
    readJob: () => ({
      status: "running",
      pid: 4242,
      logFile: "/tmp/x.log",
      threadId: "th-1",
      turnId: "tn-1"
    }),
    isProcessAlive: (pid) => pid === 4242,
    statLogMtimeMs: () => 1_000_000,
    probeBroker: async () => false,
    now: () => 1_000_000 + 950_000
  };

  const obs = await gatherObservation("/ws", "job-1", deps, CONFIG);

  assert.equal(obs.status, "running");
  assert.equal(obs.workerAlive, true);
  assert.equal(obs.quietMs, 950_000);
  assert.equal(obs.brokerOk, false);
  assert.equal(obs.pid, 4242);
  assert.equal(obs.threadId, "th-1");
  assert.equal(obs.turnId, "tn-1");
  assert.deepEqual(obs.thresholds, { hangQuietMs: 900_000, hardQuietMs: 1_800_000 });
});

test("gatherObservation returns null when the job record is gone", async () => {
  const obs = await gatherObservation("/ws", "missing", { readJob: () => null }, CONFIG);
  assert.equal(obs, null);
});

test("gatherObservation treats a job with no live pid as not alive", async () => {
  const deps = {
    readJob: () => ({ status: "running", pid: 999_999, logFile: "/tmp/x.log" }),
    isProcessAlive: () => false,
    statLogMtimeMs: () => 5_000,
    probeBroker: async () => true,
    now: () => 5_000
  };
  const obs = await gatherObservation("/ws", "job-2", deps, CONFIG);
  assert.equal(obs.workerAlive, false);
});

test("terminateHungJob interrupts, kills the tree, marks failed and writes a failed signal", async () => {
  const workspace = makeTempDir();
  const jobId = "job-hung";
  const logFile = resolveJobLogFile(workspace, jobId);
  const job = {
    id: jobId,
    status: "running",
    phase: "investigating",
    pid: process.pid,
    logFile,
    threadId: "th-9",
    turnId: "tn-9",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  writeJobFile(workspace, jobId, job);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });
  fs.writeFileSync(logFile, "", "utf8");

  const calls = { interrupt: [], terminate: [] };
  const deps = {
    interrupt: async (_cwd, ctx) => calls.interrupt.push(ctx),
    terminate: (pid) => calls.terminate.push(pid)
  };
  const observation = {
    status: "running",
    pid: 999_999,
    threadId: "th-9",
    turnId: "tn-9",
    logFile
  };

  await terminateHungJob(workspace, jobId, observation, deps, "HUNG");

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.phase, "failed");
  assert.equal(persisted.watchdogTerminated, true);
  assert.match(persisted.errorMessage ?? "", /hung|terminal/i);

  const doneFile = resolveJobDoneFile(workspace, jobId);
  assert.equal(fs.existsSync(doneFile), true);
  assert.equal(JSON.parse(fs.readFileSync(doneFile, "utf8")).status, "failed");

  assert.deepEqual(calls.interrupt, [{ threadId: "th-9", turnId: "tn-9" }]);
  assert.deepEqual(calls.terminate, [999_999]);

  const logText = fs.readFileSync(logFile, "utf8");
  assert.match(logText, /Watchdog/);
});

test("terminateHungJob skips interrupt when there is no thread/turn to interrupt", async () => {
  const workspace = makeTempDir();
  const jobId = "job-dead";
  const job = {
    id: jobId,
    status: "running",
    phase: "starting",
    pid: 999_999,
    logFile: resolveJobLogFile(workspace, jobId),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  writeJobFile(workspace, jobId, job);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });

  const calls = { interrupt: [], terminate: [] };
  const deps = {
    interrupt: async (_cwd, ctx) => calls.interrupt.push(ctx),
    terminate: (pid) => calls.terminate.push(pid)
  };
  const observation = { status: "running", pid: 999_999, threadId: null, turnId: null, logFile: job.logFile };

  await terminateHungJob(workspace, jobId, observation, deps, "DEAD");

  assert.equal(calls.interrupt.length, 0);
  assert.deepEqual(calls.terminate, [999_999]);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8")).status, "failed");
});

test("runWatchdog escalates across ticks: one quiet tick, then terminate on the second", async () => {
  const workspace = makeTempDir();
  const jobId = "job-loop";
  const logFile = resolveJobLogFile(workspace, jobId);
  const job = {
    id: jobId,
    status: "running",
    phase: "investigating",
    pid: 999_999,
    logFile,
    threadId: "th-loop",
    turnId: "tn-loop",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  writeJobFile(workspace, jobId, job);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });
  fs.writeFileSync(logFile, "", "utf8");

  const calls = { interrupt: [], terminate: [], sleeps: 0 };
  const deps = {
    readJob: () => job, // always HUNG-looking
    isProcessAlive: () => true,
    statLogMtimeMs: () => 0,
    probeBroker: async () => false,
    interrupt: async (_cwd, ctx) => calls.interrupt.push(ctx),
    terminate: (pid) => calls.terminate.push(pid),
    now: () => 10_000_000 // far past the hard ceiling vs mtime 0
  };
  const config = { intervalMs: 1, hangQuietMs: 900_000, hardQuietMs: 1_800_000, confirmRounds: 2 };

  await runWatchdog(workspace, jobId, {
    deps,
    config,
    sleep: async () => {
      calls.sleeps += 1;
    }
  });

  // First tick escalates (sleep once), second tick terminates and returns.
  assert.equal(calls.sleeps, 1);
  assert.deepEqual(calls.terminate, [999_999]);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8")).status, "failed");
});

test("runWatchdog stops without killing when the job reaches a terminal state on its own", async () => {
  const workspace = makeTempDir();
  const calls = { terminate: [] };
  const deps = {
    readJob: () => ({ status: "completed", pid: 1, logFile: "/tmp/x.log" }),
    isProcessAlive: () => true,
    statLogMtimeMs: () => 0,
    probeBroker: async () => true,
    terminate: (pid) => calls.terminate.push(pid),
    now: () => 1
  };

  await runWatchdog(workspace, "job-done", {
    deps,
    config: { intervalMs: 1, hangQuietMs: 1, hardQuietMs: 1, confirmRounds: 2 },
    sleep: async () => {
      throw new Error("should not sleep after a terminal verdict");
    }
  });

  assert.deepEqual(calls.terminate, []);
});

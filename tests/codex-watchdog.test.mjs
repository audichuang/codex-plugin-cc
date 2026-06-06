import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  resolveJobDoneFile,
  resolveJobFile,
  resolveJobLogFile,
  saveState,
  writeCompletionSignalFile,
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
  assert.deepEqual(obs.thresholds, { hangQuietMs: 900_000 });
});

test("gatherObservation flags missedOwnDeadline when now is past the job's timeoutAt", async () => {
  const deps = {
    readJob: () => ({
      status: "running",
      pid: 4242,
      logFile: "/tmp/x.log",
      timeoutAt: new Date(1_000_000).toISOString()
    }),
    isProcessAlive: () => true,
    statLogMtimeMs: () => 1_000_000,
    probeBroker: async () => true,
    now: () => 5_000_000 // well past timeoutAt
  };
  const obs = await gatherObservation("/ws", "job-late", deps, CONFIG);
  assert.equal(obs.missedOwnDeadline, true);
});

test("gatherObservation does not flag missedOwnDeadline before the deadline (or when absent)", async () => {
  const withFutureDeadline = {
    readJob: () => ({ status: "running", pid: 1, logFile: "/tmp/x.log", timeoutAt: new Date(9_000_000).toISOString() }),
    isProcessAlive: () => true,
    statLogMtimeMs: () => 1000,
    probeBroker: async () => true,
    now: () => 1000
  };
  assert.equal((await gatherObservation("/ws", "j", withFutureDeadline, CONFIG)).missedOwnDeadline, false);

  const noDeadline = {
    readJob: () => ({ status: "running", pid: 1, logFile: "/tmp/x.log" }),
    isProcessAlive: () => true,
    statLogMtimeMs: () => 1000,
    probeBroker: async () => true,
    now: () => 9_999_999
  };
  assert.equal((await gatherObservation("/ws", "j", noDeadline, CONFIG)).missedOwnDeadline, false);
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

test("terminateHungJob reports a deadline-miss reason (not 'broker unreachable') when the deadline was missed", async () => {
  const workspace = makeTempDir();
  const jobId = "job-deadline";
  const logFile = resolveJobLogFile(workspace, jobId);
  const job = {
    id: jobId,
    status: "running",
    phase: "investigating",
    pid: 999_999,
    logFile,
    threadId: "th-d",
    turnId: "tn-d",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  writeJobFile(workspace, jobId, job);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });
  fs.writeFileSync(logFile, "", "utf8");

  const deps = { interrupt: async () => {}, terminate: () => {} };
  const observation = {
    status: "running",
    pid: 999_999,
    threadId: "th-d",
    turnId: "tn-d",
    logFile,
    missedOwnDeadline: true
  };

  await terminateHungJob(workspace, jobId, observation, deps, "HUNG");

  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.match(record.errorMessage ?? "", /deadline/i);
  assert.doesNotMatch(record.errorMessage ?? "", /broker was unreachable/i);
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

test("terminateHungJob is a no-op (no kill, no signal overwrite) when the job already completed", async () => {
  const workspace = makeTempDir();
  const jobId = "job-raced";
  const logFile = resolveJobLogFile(workspace, jobId);
  const job = {
    id: jobId,
    status: "completed",
    phase: "done",
    pid: 999_999,
    logFile,
    threadId: "th-r",
    turnId: "tn-r",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  writeJobFile(workspace, jobId, job);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });
  // A pre-existing completed signal that must not be clobbered.
  writeCompletionSignalFile(workspace, jobId, { status: "completed" });

  const calls = { interrupt: [], terminate: [] };
  const deps = {
    interrupt: async (_cwd, ctx) => calls.interrupt.push(ctx),
    terminate: (pid) => calls.terminate.push(pid)
  };
  const staleObservation = { status: "running", pid: 999_999, threadId: "th-r", turnId: "tn-r", logFile };

  await terminateHungJob(workspace, jobId, staleObservation, deps, "HUNG");

  assert.equal(calls.interrupt.length, 0, "must not interrupt a job that already finished");
  assert.equal(calls.terminate.length, 0, "must not kill a pid for a job that already finished");
  assert.equal(
    JSON.parse(fs.readFileSync(resolveJobDoneFile(workspace, jobId), "utf8")).status,
    "completed",
    "must not overwrite the completed signal with failed"
  );
});

function seedHungJob(workspace, jobId, overrides = {}) {
  const logFile = resolveJobLogFile(workspace, jobId);
  const job = {
    id: jobId,
    status: "running",
    phase: "investigating",
    pid: 999_999,
    logFile,
    threadId: "th",
    turnId: "tn",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
  writeJobFile(workspace, jobId, job);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });
  fs.writeFileSync(logFile, "", "utf8");
  return logFile;
}

test("terminateHungJob escalates to terminating the broker when the interrupt does not confirm", async () => {
  const workspace = makeTempDir();
  const jobId = "job-escalate";
  const logFile = seedHungJob(workspace, jobId);

  const calls = { interrupt: [], terminate: [] };
  const deps = {
    interrupt: async (_cwd, ctx) => {
      calls.interrupt.push(ctx);
      return { attempted: true, interrupted: false, detail: "broker unreachable" };
    },
    terminate: (pid) => calls.terminate.push(pid),
    readBrokerPid: () => 54_321
  };
  // HUNG with both ids, interrupt attempted-but-unconfirmed, and the broker
  // confirmed unreachable: this is the only case where reaping the broker is safe.
  const observation = { status: "running", pid: 999_999, threadId: "th", turnId: "tn", brokerOk: false, logFile };

  await terminateHungJob(workspace, jobId, observation, deps, "HUNG");

  assert.ok(calls.terminate.includes(999_999), "must still kill the worker process tree");
  assert.ok(
    calls.terminate.includes(54_321),
    "must escalate to the broker when the courtesy interrupt did not confirm (the turn runs in the broker's app-server child)"
  );
});

test("terminateHungJob does NOT reap the broker for a DEAD verdict (no turn to reap)", async () => {
  const workspace = makeTempDir();
  const jobId = "job-dead-noreap";
  const logFile = seedHungJob(workspace, jobId, { threadId: null, turnId: null });

  const calls = { terminate: [] };
  const deps = {
    interrupt: async () => ({ attempted: false, interrupted: false }),
    terminate: (pid) => calls.terminate.push(pid),
    readBrokerPid: () => 54_321 // a broker pid IS available, but must not be killed
  };
  const observation = { status: "running", pid: 999_999, threadId: null, turnId: null, brokerOk: false, logFile };

  await terminateHungJob(workspace, jobId, observation, deps, "DEAD");

  assert.deepEqual(calls.terminate, [999_999], "a DEAD job (no turn identity) must not kill the shared broker");
});

test("terminateHungJob does NOT reap the broker when the broker is still reachable", async () => {
  const workspace = makeTempDir();
  const jobId = "job-brokerok";
  const logFile = seedHungJob(workspace, jobId);

  const calls = { terminate: [] };
  const deps = {
    interrupt: async () => ({ attempted: true, interrupted: false, detail: "Shared Codex broker is busy serving another client." }),
    terminate: (pid) => calls.terminate.push(pid),
    readBrokerPid: () => 54_321
  };
  // Broker reachable + the interrupt failure was a busy refusal → another client
  // is using the broker; killing it would abort their turn.
  const observation = { status: "running", pid: 999_999, threadId: "th", turnId: "tn", brokerOk: true, logFile };

  await terminateHungJob(workspace, jobId, observation, deps, "HUNG");

  assert.deepEqual(calls.terminate, [999_999], "a reachable/busy broker must not be reaped");
});

test("terminateHungJob leaves the broker alone when the interrupt actually confirmed", async () => {
  const workspace = makeTempDir();
  const jobId = "job-confirmed";
  const logFile = seedHungJob(workspace, jobId);

  const calls = { terminate: [] };
  const deps = {
    interrupt: async () => ({ attempted: true, interrupted: true }),
    terminate: (pid) => calls.terminate.push(pid),
    readBrokerPid: () => 54_321
  };
  const observation = { status: "running", pid: 999_999, threadId: "th", turnId: "tn", logFile };

  await terminateHungJob(workspace, jobId, observation, deps, "HUNG");

  assert.deepEqual(calls.terminate, [999_999], "a confirmed interrupt must not escalate to killing the shared broker");
});

test("terminateHungJob does not interrupt when only one of threadId/turnId is present (interrupt needs both)", async () => {
  const workspace = makeTempDir();
  const jobId = "job-halfid";
  const logFile = seedHungJob(workspace, jobId, { turnId: null });

  const calls = { interrupt: [], terminate: [] };
  const deps = {
    interrupt: async (_cwd, ctx) => calls.interrupt.push(ctx),
    terminate: (pid) => calls.terminate.push(pid)
  };
  const observation = { status: "running", pid: 999_999, threadId: "th-only", turnId: null, logFile };

  await terminateHungJob(workspace, jobId, observation, deps, "HUNG");

  assert.equal(calls.interrupt.length, 0, "interruptAppServerTurn no-ops without both ids, so the watchdog must not pretend it interrupted");
  assert.deepEqual(calls.terminate, [999_999]);
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

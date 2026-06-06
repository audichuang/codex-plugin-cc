import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyLiveness,
  createLivenessGate,
  resolveWatchdogConfig
} from "../plugins/codex/scripts/lib/liveness.mjs";

const THRESHOLDS = { hangQuietMs: 900_000, hardQuietMs: 1_800_000 };

test("classifyLiveness reports DONE for a terminal job regardless of other signals", () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    const verdict = classifyLiveness({
      status,
      workerAlive: false,
      quietMs: 10_000_000,
      brokerOk: false,
      thresholds: THRESHOLDS
    });
    assert.equal(verdict, "DONE", `status=${status}`);
  }
});

test("classifyLiveness reports DEAD when the worker process is gone", () => {
  const verdict = classifyLiveness({
    status: "running",
    workerAlive: false,
    quietMs: 0,
    brokerOk: true,
    thresholds: THRESHOLDS
  });
  assert.equal(verdict, "DEAD");
});

test("classifyLiveness reports HUNG when quiet beyond hangQuiet AND broker unreachable", () => {
  const verdict = classifyLiveness({
    status: "running",
    workerAlive: true,
    quietMs: 1_000_000,
    brokerOk: false,
    thresholds: THRESHOLDS
  });
  assert.equal(verdict, "HUNG");
});

test("classifyLiveness stays HEALTHY when quiet beyond hangQuiet but broker is still reachable", () => {
  // A long but legitimate tool/build run: events are quiet yet the broker
  // answers, so we must NOT kill it.
  const verdict = classifyLiveness({
    status: "running",
    workerAlive: true,
    quietMs: 1_000_000,
    brokerOk: true,
    thresholds: THRESHOLDS
  });
  assert.equal(verdict, "HEALTHY");
});

test("classifyLiveness reports HUNG past the hard ceiling even when broker is reachable", () => {
  const verdict = classifyLiveness({
    status: "running",
    workerAlive: true,
    quietMs: 2_000_000,
    brokerOk: true,
    thresholds: THRESHOLDS
  });
  assert.equal(verdict, "HUNG");
});

test("classifyLiveness stays HEALTHY for a recently-active worker", () => {
  const verdict = classifyLiveness({
    status: "running",
    workerAlive: true,
    quietMs: 30_000,
    brokerOk: true,
    thresholds: THRESHOLDS
  });
  assert.equal(verdict, "HEALTHY");
});

test("resolveWatchdogConfig defaults to a 5-minute interval and sane quiet thresholds", () => {
  const config = resolveWatchdogConfig({});
  assert.equal(config.intervalMs, 300_000);
  assert.equal(config.hangQuietMs, 900_000);
  assert.equal(config.hardQuietMs, 1_800_000);
  assert.equal(config.confirmRounds, 2);
});

test("resolveWatchdogConfig honours env overrides and ignores invalid values", () => {
  const config = resolveWatchdogConfig({
    CODEX_WATCHDOG_INTERVAL_MS: "120000",
    CODEX_WATCHDOG_HANG_QUIET_MS: "0",
    CODEX_WATCHDOG_HARD_QUIET_MS: "not-a-number"
  });
  assert.equal(config.intervalMs, 120_000);
  assert.equal(config.hangQuietMs, 900_000, "invalid (<=0) falls back to default");
  assert.equal(config.hardQuietMs, 1_800_000, "non-numeric falls back to default");
});

test("createLivenessGate escalates instead of killing: terminate only after confirmRounds bad verdicts", () => {
  const gate = createLivenessGate({ confirmRounds: 2 });

  const first = gate.assess({ status: "running", workerAlive: true, quietMs: 2_000_000, brokerOk: false, thresholds: THRESHOLDS });
  assert.equal(first.verdict, "HUNG");
  assert.equal(first.action, "none", "first bad tick only escalates, does not kill");

  const second = gate.assess({ status: "running", workerAlive: true, quietMs: 2_000_000, brokerOk: false, thresholds: THRESHOLDS });
  assert.equal(second.verdict, "HUNG");
  assert.equal(second.action, "terminate", "second consecutive bad tick triggers terminate");
});

test("createLivenessGate resets its escalation counter after a healthy tick", () => {
  const gate = createLivenessGate({ confirmRounds: 2 });

  gate.assess({ status: "running", workerAlive: true, quietMs: 2_000_000, brokerOk: false, thresholds: THRESHOLDS });
  const healthy = gate.assess({ status: "running", workerAlive: true, quietMs: 10_000, brokerOk: true, thresholds: THRESHOLDS });
  assert.equal(healthy.verdict, "HEALTHY");
  assert.equal(healthy.action, "none");

  // Counter reset: a single subsequent bad tick must not terminate yet.
  const afterReset = gate.assess({ status: "running", workerAlive: true, quietMs: 2_000_000, brokerOk: false, thresholds: THRESHOLDS });
  assert.equal(afterReset.action, "none");
});

test("createLivenessGate signals stop on a terminal verdict", () => {
  const gate = createLivenessGate({ confirmRounds: 2 });
  const done = gate.assess({ status: "completed", workerAlive: false, quietMs: 0, brokerOk: false, thresholds: THRESHOLDS });
  assert.equal(done.verdict, "DONE");
  assert.equal(done.action, "stop");
});

test("createLivenessGate terminates a DEAD worker after confirmRounds too", () => {
  const gate = createLivenessGate({ confirmRounds: 2 });
  gate.assess({ status: "running", workerAlive: false, quietMs: 0, brokerOk: true, thresholds: THRESHOLDS });
  const second = gate.assess({ status: "running", workerAlive: false, quietMs: 0, brokerOk: true, thresholds: THRESHOLDS });
  assert.equal(second.verdict, "DEAD");
  assert.equal(second.action, "terminate");
});

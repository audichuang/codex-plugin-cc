import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import {
  captureTurn,
  resolveTurnIdleTimeoutMs,
  TURN_IDLE_TIMEOUT_ENV,
  DEFAULT_TURN_IDLE_TIMEOUT_MS
} from "../plugins/codex/scripts/lib/codex.mjs";

// Controllable timer set injected into captureTurn's idle watchdog so the test
// decides exactly when "idle" elapses — no wall-clock flakiness. Global timers
// stay real for test sequencing.
function fakeTimers() {
  let nextId = 0;
  const active = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++nextId;
      active.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      active.delete(id);
    },
    pending() {
      return active.size;
    },
    fireLast() {
      const id = [...active.keys()].pop();
      const entry = active.get(id);
      active.delete(id);
      entry.fn();
    }
  };
}

function makeFakeClient() {
  return {
    notificationHandler: null,
    exitError: null,
    setNotificationHandler(fn) {
      this.notificationHandler = fn;
    },
    // Never resolves: the transport watchdog must not interfere with idle tests.
    exitPromise: new Promise(() => {})
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("resolveTurnIdleTimeoutMs is disabled (0) by default", () => {
  assert.equal(DEFAULT_TURN_IDLE_TIMEOUT_MS, 0);
  assert.equal(resolveTurnIdleTimeoutMs({ env: {} }), 0);
});

test("resolveTurnIdleTimeoutMs honours the env knob and option override", () => {
  assert.equal(resolveTurnIdleTimeoutMs({ env: { [TURN_IDLE_TIMEOUT_ENV]: "300000" } }), 300000);
  assert.equal(resolveTurnIdleTimeoutMs({ env: { [TURN_IDLE_TIMEOUT_ENV]: "0" } }), 0);
  assert.equal(resolveTurnIdleTimeoutMs({ env: { [TURN_IDLE_TIMEOUT_ENV]: "junk" } }), 0);
  assert.equal(resolveTurnIdleTimeoutMs({ env: { [TURN_IDLE_TIMEOUT_ENV]: "-5" } }), 0);
  // explicit option wins over env
  assert.equal(resolveTurnIdleTimeoutMs({ idleTimeoutMs: 1234, env: { [TURN_IDLE_TIMEOUT_ENV]: "9" } }), 1234);
});

test("captureTurn rejects with a thread/turn-tagged idle error when the stream goes silent", async () => {
  const client = makeFakeClient();
  const timers = fakeTimers();
  const promise = captureTurn(
    client,
    "thread1",
    async () => ({ turn: { id: "turn1", status: "inProgress" } }),
    { idleTimeoutMs: 5000, timers }
  );
  await tick();
  assert.equal(timers.pending(), 1, "an idle timer must be armed once the turn is in progress");

  timers.fireLast(); // simulate the idle window elapsing with no further activity

  await assert.rejects(promise, (error) => {
    assert.equal(error.threadId, "thread1");
    assert.equal(error.turnId, "turn1");
    assert.equal(error.idleTimeoutMs, 5000);
    assert.match(error.message, /idle|stall|activity/i);
    return true;
  });
});

test("captureTurn keeps the turn alive while notifications arrive, then completes cleanly", async () => {
  const client = makeFakeClient();
  const timers = fakeTimers();
  const promise = captureTurn(
    client,
    "thread1",
    async () => ({ turn: { id: "turn1", status: "inProgress" } }),
    { idleTimeoutMs: 5000, timers }
  );
  await tick();

  // Any inbound activity resets the idle window (the previous timer is cleared).
  // An out-of-turn notification still counts as liveness and exercises the reset
  // without coupling to item-rendering internals.
  for (let i = 0; i < 3; i += 1) {
    client.notificationHandler({ method: "item/started", params: { threadId: "subthread-x" } });
    assert.equal(timers.pending(), 1, "exactly one idle timer should be armed after a reset");
  }

  client.notificationHandler({
    method: "turn/completed",
    params: { threadId: "thread1", turn: { id: "turn1", status: "completed" } }
  });

  const state = await promise;
  assert.equal(state.completed, true);
  assert.equal(timers.pending(), 0, "the idle timer must be cleared once the turn completes");
});

test("captureTurn arms no idle timer when the idle timeout is disabled (0)", async () => {
  const client = makeFakeClient();
  const timers = fakeTimers();
  const promise = captureTurn(
    client,
    "thread1",
    async () => ({ turn: { id: "turn1", status: "inProgress" } }),
    { idleTimeoutMs: 0, timers }
  );
  await tick();
  assert.equal(timers.pending(), 0, "a disabled idle timeout must not arm any watchdog timer");

  // Complete it so the test does not leave a dangling promise.
  client.notificationHandler({
    method: "turn/completed",
    params: { threadId: "thread1", turn: { id: "turn1", status: "completed" } }
  });
  await promise;
});

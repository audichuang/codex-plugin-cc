import test from "node:test";
import assert from "node:assert/strict";

import { createIdleTracker } from "../plugins/codex/scripts/lib/idle-shutdown.mjs";

function fakeTimers() {
  let scheduled = null;
  return {
    setTimer: (fn, ms) => {
      scheduled = { fn, ms };
      return { unref() {} };
    },
    clearTimer: () => {
      scheduled = null;
    },
    fire: () => {
      const job = scheduled;
      scheduled = null;
      job?.fn();
    },
    get pending() {
      return scheduled;
    }
  };
}

test("idleStart arms a timer that fires onIdle when nothing connects", () => {
  const timers = fakeTimers();
  let idled = 0;
  const tracker = createIdleTracker({
    timeoutMs: 5000,
    onIdle: () => (idled += 1),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });

  tracker.idleStart();
  assert.equal(tracker.armed, true);
  assert.equal(timers.pending.ms, 5000);

  timers.fire();
  assert.equal(idled, 1);
});

test("connect cancels a pending idle timer", () => {
  const timers = fakeTimers();
  let idled = 0;
  const tracker = createIdleTracker({ timeoutMs: 5000, onIdle: () => (idled += 1), setTimer: timers.setTimer, clearTimer: timers.clearTimer });

  tracker.idleStart();
  tracker.connect();
  assert.equal(tracker.armed, false);
  assert.equal(tracker.count, 1);
});

test("disconnecting the last client re-arms the idle timer", () => {
  const timers = fakeTimers();
  const tracker = createIdleTracker({ timeoutMs: 5000, onIdle: () => {}, setTimer: timers.setTimer, clearTimer: timers.clearTimer });

  tracker.connect();
  tracker.disconnect();
  assert.equal(tracker.count, 0);
  assert.equal(tracker.armed, true);
});

test("a remaining client keeps the broker alive (no arm) when one of several disconnects", () => {
  const timers = fakeTimers();
  let idled = 0;
  const tracker = createIdleTracker({ timeoutMs: 5000, onIdle: () => (idled += 1), setTimer: timers.setTimer, clearTimer: timers.clearTimer });

  tracker.connect();
  tracker.connect();
  tracker.disconnect();
  assert.equal(tracker.count, 1);
  assert.equal(tracker.armed, false);
  assert.equal(idled, 0);
});

test("arm is a no-op while clients are connected", () => {
  const timers = fakeTimers();
  const tracker = createIdleTracker({ timeoutMs: 5000, onIdle: () => {}, setTimer: timers.setTimer, clearTimer: timers.clearTimer });

  tracker.connect();
  tracker.idleStart();
  assert.equal(tracker.armed, false);
});

test("disconnect never drives the count negative", () => {
  const timers = fakeTimers();
  const tracker = createIdleTracker({ timeoutMs: 5000, onIdle: () => {}, setTimer: timers.setTimer, clearTimer: timers.clearTimer });

  tracker.disconnect();
  tracker.disconnect();
  assert.equal(tracker.count, 0);
});

import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { isSessionStale } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

// A broker that crashed can leave a reusable-looking session: its recorded pid is
// dead but a stale unix socket may still ping. Reuse must be gated on the pid
// being alive, not just the endpoint answering.

test("isSessionStale is true when the recorded broker pid is dead", () => {
  assert.equal(isSessionStale({ pid: 4242 }, { isProcessAlive: () => false }), true);
});

test("isSessionStale is false when the recorded broker pid is alive", () => {
  assert.equal(isSessionStale({ pid: 4242 }, { isProcessAlive: () => true }), false);
});

test("isSessionStale is false when no pid is recorded (cannot prove death; rely on endpoint check)", () => {
  assert.equal(isSessionStale({ pid: null }, { isProcessAlive: () => false }), false);
  assert.equal(isSessionStale({}, { isProcessAlive: () => false }), false);
});

test("isSessionStale is false for a non-integer pid (cannot prove death)", () => {
  assert.equal(isSessionStale({ pid: "nope" }, { isProcessAlive: () => false }), false);
  assert.equal(isSessionStale({ pid: 0 }, { isProcessAlive: () => false }), false);
});

test("isSessionStale tolerates a null session", () => {
  assert.equal(isSessionStale(null, { isProcessAlive: () => false }), false);
});

import test from "node:test";
import assert from "node:assert/strict";

import { shouldRefuseBrokerShutdown } from "../plugins/codex/scripts/app-server-broker.mjs";

const me = Symbol("me");
const other = Symbol("other");

test("broker refuses shutdown while another client owns the active stream", () => {
  assert.equal(shouldRefuseBrokerShutdown(other, null, me), true);
});

test("broker refuses shutdown while another client owns the active request", () => {
  assert.equal(shouldRefuseBrokerShutdown(null, other, me), true);
});

test("broker allows shutdown when idle (no active stream or request)", () => {
  assert.equal(shouldRefuseBrokerShutdown(null, null, me), false);
});

test("broker allows shutdown when the requester itself owns the active stream/request", () => {
  assert.equal(shouldRefuseBrokerShutdown(me, me, me), false);
});

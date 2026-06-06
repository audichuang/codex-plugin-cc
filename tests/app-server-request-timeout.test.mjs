import test from "node:test";
import assert from "node:assert/strict";

import {
  AppServerClientBase,
  resolveRequestTimeoutMs
} from "../plugins/codex/scripts/lib/app-server.mjs";

class SilentClient extends AppServerClientBase {
  // Never responds, so a request can only settle via timeout.
  sendMessage() {}
}

class CapturingClient extends AppServerClientBase {
  constructor() {
    super("/tmp");
    this.sent = [];
  }
  sendMessage(message) {
    this.sent.push(message);
  }
}

class ThrowingClient extends AppServerClientBase {
  sendMessage() {
    throw new Error("send failed");
  }
}

test("request rejects and clears the pending entry when sendMessage throws synchronously", async () => {
  const client = new ThrowingClient("/tmp");
  await assert.rejects(client.request("thread/list", {}, { timeoutMs: 0 }), /send failed/);
  assert.equal(client.pending.size, 0, "a failed send must not leave a leaked pending entry");
});

test("resolveRequestTimeoutMs defaults to 120s and lets 0 disable it", () => {
  assert.equal(resolveRequestTimeoutMs({}), 120_000);
  assert.equal(resolveRequestTimeoutMs({ CODEX_REQUEST_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(resolveRequestTimeoutMs({ CODEX_REQUEST_TIMEOUT_MS: "0" }), 0);
  assert.equal(resolveRequestTimeoutMs({ CODEX_REQUEST_TIMEOUT_MS: "junk" }), 120_000);
});

test("request rejects with a timeout error when the server never responds", async () => {
  const client = new SilentClient("/tmp");
  await assert.rejects(client.request("thread/list", {}, { timeoutMs: 30 }), /timed out/i);
});

test("request resolves normally and does not later fire the timeout", async () => {
  const client = new CapturingClient();
  const promise = client.request("thread/list", {}, { timeoutMs: 50 });

  const sentId = client.sent[0].id;
  client.handleLine(JSON.stringify({ id: sentId, result: { ok: true } }));

  const result = await promise;
  assert.deepEqual(result, { ok: true });

  // Wait past the timeout window; a cleared timer must not reject the
  // already-resolved request or crash the process.
  await new Promise((resolve) => setTimeout(resolve, 80));
});

test("a per-request timeoutMs of 0 disables the timeout", async () => {
  const client = new CapturingClient();
  const promise = client.request("thread/list", {}, { timeoutMs: 0 });
  const sentId = client.sent[0].id;
  // Still pending after a tick because no timeout is armed.
  await new Promise((resolve) => setTimeout(resolve, 20));
  client.handleLine(JSON.stringify({ id: sentId, result: { done: 1 } }));
  assert.deepEqual(await promise, { done: 1 });
});

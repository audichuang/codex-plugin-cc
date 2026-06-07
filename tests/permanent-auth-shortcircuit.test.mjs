import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { captureTurn, isTerminalTurnError } from "../plugins/codex/scripts/lib/codex.mjs";

function makeFakeClient() {
  return {
    notificationHandler: null,
    exitError: null,
    setNotificationHandler(fn) {
      this.notificationHandler = fn;
    },
    exitPromise: new Promise(() => {}) // never resolves
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("isTerminalTurnError trusts the protocol willRetry flag", () => {
  // willRetry === false is the authoritative "this error is terminal" signal.
  assert.equal(isTerminalTurnError({ willRetry: false, error: { message: "anything at all" } }), true);
  // willRetry === true means the app-server will auto-retry — never short-circuit,
  // even if the message looks auth-like.
  assert.equal(isTerminalTurnError({ willRetry: true, error: { message: "401 Unauthorized" } }), false);
});

test("isTerminalTurnError falls back to a NARROW permanent-auth regex when willRetry is absent", () => {
  for (const msg of ["401 Unauthorized", "403 Forbidden", "Missing bearer token", "invalid API key", "authentication failed"]) {
    assert.equal(isTerminalTurnError({ error: { message: msg } }), true, `should short-circuit on: ${msg}`);
  }
});

test("isTerminalTurnError does NOT treat transient/server errors as terminal", () => {
  for (const msg of ["429 Too Many Requests", "rate limit exceeded", "500 Internal Server Error", "503 Service Unavailable", "overloaded", "network timeout", ""]) {
    assert.equal(isTerminalTurnError({ error: { message: msg } }), false, `must NOT short-circuit on: ${msg}`);
  }
});

test("captureTurn completes the turn as failed on a terminal (non-retryable) error", async () => {
  const client = makeFakeClient();
  const promise = captureTurn(
    client,
    "thread1",
    async () => ({ turn: { id: "turn1", status: "inProgress" } }),
    {}
  );
  await tick();
  client.notificationHandler({
    method: "error",
    params: { threadId: "thread1", turnId: "turn1", willRetry: false, error: { message: "401 Unauthorized" } }
  });
  const state = await promise; // must resolve, not hang
  assert.equal(state.completed, true);
  assert.equal(state.finalTurn.status, "failed");
  assert.match(state.error.message, /401/);
});

test("captureTurn does not crash on a malformed error notification missing the error field", async () => {
  const client = makeFakeClient();
  const promise = captureTurn(
    client,
    "thread1",
    async () => ({ turn: { id: "turn1", status: "inProgress" } }),
    {}
  );
  await tick();
  // A protocol-malformed `error` notification: params present but NO `error`
  // object. The handler must not dereference params.error.message — that throws a
  // TypeError synchronously inside the stream listener, which has no try/catch and
  // crashes the whole host process.
  assert.doesNotThrow(() => {
    client.notificationHandler({ method: "error", params: { threadId: "thread1", turnId: "turn1" } });
  });
  // It carries no terminal signal, so the turn completes via the real event.
  client.notificationHandler({
    method: "turn/completed",
    params: { threadId: "thread1", turn: { id: "turn1", status: "completed" } }
  });
  const state = await promise;
  assert.equal(state.finalTurn.status, "completed");
});

test("a terminal error on a SUBAGENT thread does not fail the root turn", async () => {
  const client = makeFakeClient();
  const promise = captureTurn(
    client,
    "root",
    async () => ({ turn: { id: "rootturn", status: "inProgress" } }),
    {}
  );
  await tick();
  // Register a subagent thread (thread/started is applied unconditionally).
  client.notificationHandler({ method: "thread/started", params: { thread: { id: "sub", name: "subagent" } } });
  // A terminal error on the SUBAGENT thread must not pre-empt the parent turn.
  client.notificationHandler({
    method: "error",
    params: { threadId: "sub", turnId: "subturn", willRetry: false, error: { message: "subagent sandbox error" } }
  });
  // The root turn then completes normally.
  client.notificationHandler({
    method: "turn/completed",
    params: { threadId: "root", turn: { id: "rootturn", status: "completed" } }
  });
  const state = await promise;
  assert.equal(state.finalTurn.status, "completed", "a subagent-thread error must not fail the root turn");
});

test("captureTurn does NOT short-circuit on a transient error (willRetry) — the real turn/completed wins", async () => {
  const client = makeFakeClient();
  const promise = captureTurn(
    client,
    "thread1",
    async () => ({ turn: { id: "turn1", status: "inProgress" } }),
    {}
  );
  await tick();
  client.notificationHandler({
    method: "error",
    params: { threadId: "thread1", turnId: "turn1", willRetry: true, error: { message: "429 Too Many Requests" } }
  });
  // The turn keeps going and later completes normally.
  client.notificationHandler({
    method: "turn/completed",
    params: { threadId: "thread1", turn: { id: "turn1", status: "completed" } }
  });
  const state = await promise;
  assert.equal(state.finalTurn.status, "completed", "a transient error must not pre-empt the real completion");
});

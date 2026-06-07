import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { reapStaleBroker, sendBrokerShutdown, teardownBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

test("reapStaleBroker escalates to SIGKILL when a broker ignores SIGTERM (identity confirmed)", async () => {
  const killed = [];
  const forced = [];
  await reapStaleBroker(
    { endpoint: "unix:/tmp/cxc-x/broker.sock", pidFile: null, logFile: null, sessionDir: null, pid: 4242 },
    {
      killProcess: (pid) => killed.push(pid),
      isProcessAlive: () => true, // never dies on the graceful SIGTERM
      verifyIdentity: () => true, // still our broker
      forceKill: (pid) => forced.push(pid),
      sleep: async () => {},
      escalateAfterMs: 200
    }
  );
  assert.deepEqual(killed, [4242], "the graceful SIGTERM (teardown) is attempted first");
  assert.deepEqual(forced, [4242], "a confirmed-still-alive broker that survives SIGTERM must be SIGKILLed");
});

test("reapStaleBroker does NOT SIGKILL when the pid can no longer be confirmed as our broker (recycled pid)", async () => {
  const forced = [];
  await reapStaleBroker(
    { endpoint: "unix:/tmp/cxc-x/broker.sock", pid: 4242 },
    {
      killProcess: () => {},
      isProcessAlive: () => true, // something is alive at this pid...
      verifyIdentity: () => false, // ...but it is NOT our broker (pid was recycled)
      forceKill: (pid) => forced.push(pid),
      sleep: async () => {},
      escalateAfterMs: 200
    }
  );
  assert.deepEqual(forced, [], "must not SIGKILL an unrelated process that reused the broker's old pid");
});

test("reapStaleBroker does not SIGKILL a broker that exits on SIGTERM", async () => {
  const forced = [];
  let aliveCalls = 0;
  await reapStaleBroker(
    { pid: 4242 },
    {
      killProcess: () => {},
      isProcessAlive: () => {
        aliveCalls += 1;
        return aliveCalls < 2; // alive once, then gone
      },
      forceKill: (pid) => forced.push(pid),
      sleep: async () => {},
      escalateAfterMs: 500
    }
  );
  assert.deepEqual(forced, [], "no SIGKILL once the broker has already exited");
});

async function withFakeBroker(responder, fn) {
  const dir = makeTempDir();
  const sockPath = path.join(dir, "broker.sock");
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.setEncoding("utf8");
    socket.on("data", () => {
      const reply = responder();
      if (reply !== null) {
        socket.write(`${JSON.stringify(reply)}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, resolve);
  });
  try {
    return await fn(`unix:${sockPath}`);
  } finally {
    for (const socket of connections) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

test("sendBrokerShutdown reports busy when the broker refuses (shutdown must not tear down a shared broker)", async () => {
  const result = await withFakeBroker(
    () => ({ id: 1, error: { code: -32001, message: "Shared Codex broker is busy serving another client; shutdown refused." } }),
    (endpoint) => sendBrokerShutdown(endpoint, 1000)
  );
  assert.equal(result.busy, true);
});

test("sendBrokerShutdown parses a busy response split across socket chunks (must not done() on a partial line)", async () => {
  // Codex deep-review BLOCKER: the data handler called done() after ANY chunk,
  // even before a complete newline-terminated JSON line arrived. A busy -32001
  // reply fragmented across two TCP/socket chunks was then read as busy:false,
  // letting SessionEnd tear down a still-busy shared broker.
  const dir = makeTempDir();
  const sockPath = path.join(dir, "broker.sock");
  const payload =
    JSON.stringify({ id: 1, error: { code: -32001, message: "Shared Codex broker is busy serving another client; shutdown refused." } }) + "\n";
  const splitAt = Math.floor(payload.length / 2); // mid-JSON, well before the trailing newline
  const conns = [];
  const server = net.createServer((socket) => {
    conns.push(socket);
    socket.on("data", () => {
      socket.write(payload.slice(0, splitAt));
      setTimeout(() => socket.write(payload.slice(splitAt)), 30);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, resolve);
  });
  try {
    const result = await sendBrokerShutdown(`unix:${sockPath}`, 1000);
    assert.equal(result.busy, true, "a fragmented busy response must still be parsed as busy");
  } finally {
    for (const socket of conns) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("sendBrokerShutdown reports not-busy when the broker acknowledges shutdown", async () => {
  const result = await withFakeBroker(
    () => ({ id: 1, result: {} }),
    (endpoint) => sendBrokerShutdown(endpoint, 1000)
  );
  assert.equal(result.busy, false);
});

test("sendBrokerShutdown resolves within its timeout when the broker accepts but never replies", { timeout: 4000 }, async () => {
  const dir = makeTempDir();
  const sockPath = path.join(dir, "broker.sock");
  // A broker that accepts the connection but never sends a response and never
  // closes the socket — the exact wedge that could hang the SessionEnd hook.
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, resolve);
  });
  try {
    const start = Date.now();
    await sendBrokerShutdown(`unix:${sockPath}`, 200);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3000, `sendBrokerShutdown must not block on an unresponsive broker (took ${elapsed}ms)`);
  } finally {
    // Destroy any server-side connections so server.close() can complete (it
    // otherwise waits for the lingering accepted socket).
    for (const socket of connections) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test("teardownBrokerSession kills the broker tree and removes its artifacts", () => {
  const sessionDir = makeTempDir("cxc-teardown-");
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const socketPath = path.join(sessionDir, "broker.sock");
  fs.writeFileSync(pidFile, "12345\n");
  fs.writeFileSync(logFile, "log\n");
  fs.writeFileSync(socketPath, "");

  const killed = [];
  teardownBrokerSession({
    endpoint: `unix:${socketPath}`,
    pidFile,
    logFile,
    sessionDir,
    pid: 12345,
    killProcess: (pid) => killed.push(pid)
  });

  assert.deepEqual(killed, [12345], "the broker pid must be killed");
  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(logFile), false);
  assert.equal(fs.existsSync(socketPath), false);
  assert.equal(fs.existsSync(sessionDir), false);
});

test("teardownBrokerSession tolerates a missing pid without throwing", () => {
  const sessionDir = makeTempDir("cxc-teardown-nopid-");
  const logFile = path.join(sessionDir, "broker.log");
  fs.writeFileSync(logFile, "log\n");

  let called = 0;
  assert.doesNotThrow(() =>
    teardownBrokerSession({
      logFile,
      sessionDir,
      pid: null,
      killProcess: () => (called += 1)
    })
  );
  assert.equal(called, 0, "no kill attempt when there is no pid");
  assert.equal(fs.existsSync(logFile), false);
});

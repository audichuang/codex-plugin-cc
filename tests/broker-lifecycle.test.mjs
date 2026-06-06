import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { teardownBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

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

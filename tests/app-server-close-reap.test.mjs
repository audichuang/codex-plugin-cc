import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { SpawnedCodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";

// On graceful shutdown the broker calls appClient.close(); on POSIX that used to
// send a bare SIGTERM to the codex app-server pid only, orphaning its MCP/tool
// subprocesses. close() must reap the whole tree via terminateProcessTree on
// every platform.

test("terminateChild reaps the whole process tree (terminateProcessTree), never a bare proc.kill", () => {
  const reaped = [];
  const client = new SpawnedCodexAppServerClient("/ws", {
    terminateProcessTreeImpl: (pid) => {
      reaped.push(pid);
    }
  });
  client.proc = {
    pid: 4242,
    killed: false,
    exitCode: null,
    kill() {
      throw new Error("close must not bare-kill the direct child; it must reap the tree");
    }
  };

  client.terminateChild();

  assert.deepEqual(reaped, [4242]);
});

test("terminateChild does nothing once the child has already exited", () => {
  const reaped = [];
  const client = new SpawnedCodexAppServerClient("/ws", {
    terminateProcessTreeImpl: (pid) => reaped.push(pid)
  });
  client.proc = { pid: 4242, killed: false, exitCode: 0 };

  client.terminateChild();

  assert.deepEqual(reaped, []);
});

test("terminateChild swallows reaper errors (best-effort cleanup)", () => {
  const client = new SpawnedCodexAppServerClient("/ws", {
    terminateProcessTreeImpl: () => {
      throw new Error("kill boom");
    }
  });
  client.proc = { pid: 4242, killed: false, exitCode: null };

  assert.doesNotThrow(() => client.terminateChild());
});

import test from "node:test";
import assert from "node:assert/strict";

import { isProcessAlive, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("isProcessAlive returns true for the current process", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("isProcessAlive returns false for a pid that was never assigned", () => {
  // PID_MAX on Linux/macOS is below 4 million; 2**31 - 1 will never exist.
  assert.equal(isProcessAlive(2147483646), false);
});

test("isProcessAlive rejects malformed pid values without throwing", () => {
  for (const bogus of [0, -1, NaN, Number.POSITIVE_INFINITY, undefined, null, "", "not-a-number", {}, []]) {
    assert.equal(isProcessAlive(bogus), false, `expected false for ${String(bogus)}`);
  }
});

test("isProcessAlive accepts numeric strings that parse to a live pid", () => {
  assert.equal(isProcessAlive(String(process.pid)), true);
});

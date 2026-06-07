import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

// A wedged Codex app-server is NOT a process-group leader (it is spawned inside
// the broker's group), so kill(-pid) alone cannot reap its MCP/tool children.
// terminateProcessTree must enumerate the descendant pids (best-effort, via ps)
// and signal them too, so a graceful broker close from the codex pid — and a
// watchdog reap from the broker pid — both reap the whole subtree.

function recordingKill() {
  const calls = [];
  const kill = (pid, signal) => {
    calls.push({ pid, signal });
  };
  return { kill, calls };
}

// Fake process table: 500 -> [600, 601]; 600 -> [700]. Descendants of 500 are 600,601,700.
const PS_TABLE = [
  { pid: 1, ppid: 0 },
  { pid: 500, ppid: 1 },
  { pid: 600, ppid: 500 },
  { pid: 601, ppid: 500 },
  { pid: 700, ppid: 600 },
  { pid: 900, ppid: 1 } // unrelated
];

test("terminateProcessTree signals descendant pids discovered via ps (POSIX)", () => {
  const { kill, calls } = recordingKill();
  terminateProcessTree(500, {
    platform: "linux",
    killImpl: kill,
    psImpl: () => PS_TABLE
  });
  const signalled = calls.map((c) => c.pid);
  // descendants reaped
  assert.ok(signalled.includes(600), "child 600 must be signalled");
  assert.ok(signalled.includes(601), "child 601 must be signalled");
  assert.ok(signalled.includes(700), "grandchild 700 must be signalled");
  // unrelated process never touched
  assert.ok(!signalled.includes(900), "unrelated pid 900 must NOT be signalled");
  // the group/root is still signalled (existing behavior)
  assert.ok(signalled.includes(-500) || signalled.includes(500), "the root/group must still be signalled");
});

test("terminateProcessTree still group-kills when ps enumeration fails (graceful degradation)", () => {
  const { kill, calls } = recordingKill();
  const outcome = terminateProcessTree(500, {
    platform: "linux",
    killImpl: kill,
    psImpl: () => {
      throw new Error("ps unavailable");
    }
  });
  assert.deepEqual(calls, [{ pid: -500, signal: "SIGTERM" }], "must fall back to a plain group kill");
  assert.equal(outcome.method, "process-group");
  assert.equal(outcome.delivered, true);
});

test("terminateProcessTree reaps descendants then falls back to a single kill when the child is not a group leader", () => {
  const calls = [];
  const outcome = terminateProcessTree(500, {
    platform: "linux",
    psImpl: () => PS_TABLE,
    killImpl: (pid, signal) => {
      calls.push({ pid, signal });
      if (pid === -500) {
        const err = new Error("no such group");
        err.code = "ESRCH";
        throw err; // 500 is not a group leader
      }
    }
  });
  const signalled = calls.map((c) => c.pid);
  assert.ok(signalled.includes(600) && signalled.includes(601) && signalled.includes(700), "descendants reaped");
  assert.ok(signalled.includes(-500), "group kill attempted first");
  assert.ok(signalled.includes(500), "falls back to a direct kill of the non-leader root");
  assert.equal(outcome.method, "process");
});

import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { readHookInput, readStdinSync } from "../plugins/codex/scripts/lib/hook-input.mjs";

// Build an fs.readSync-compatible stub from a script of steps. Each step is one
// of: { throw: "EAGAIN" }, { data: "<chunk>" }, { eof: true }. The stub writes
// chunk bytes into the caller's buffer and returns the byte count, matching the
// real readSync(fd, buffer, offset, length, position) contract.
function scriptedRead(steps) {
  let i = 0;
  return (_fd, buffer, offset = 0, length = buffer.length) => {
    const step = steps[i++];
    if (!step || step.eof) {
      return 0; // EOF
    }
    if (step.throw) {
      const err = new Error(step.throw);
      err.code = step.throw;
      throw err;
    }
    const bytes = Buffer.from(step.data, "utf8");
    const n = Math.min(bytes.length, length);
    bytes.copy(buffer, offset, 0, n);
    return n;
  };
}

const noopSleep = () => {};

test("readStdinSync assembles a payload delivered after a transient EAGAIN", () => {
  const readImpl = scriptedRead([
    { throw: "EAGAIN" },
    { data: '{"session_id":"abc"}' },
    { eof: true }
  ]);
  const raw = readStdinSync(0, { readImpl, sleep: noopSleep });
  assert.equal(raw, '{"session_id":"abc"}');
});

test("readStdinSync assembles a payload split across multiple reads", () => {
  const readImpl = scriptedRead([
    { data: '{"session_id":' },
    { data: '"abc"}' },
    { eof: true }
  ]);
  assert.equal(readStdinSync(0, { readImpl, sleep: noopSleep }), '{"session_id":"abc"}');
});

test("readStdinSync resets the EAGAIN budget after each successful read", () => {
  // maxEagainRetries=1 tolerates only ONE consecutive EAGAIN. Two single EAGAINs
  // separated by a successful read must both survive — proving reset-on-progress.
  const readImpl = scriptedRead([
    { throw: "EAGAIN" },
    { data: "AA" },
    { throw: "EAGAIN" },
    { data: "BB" },
    { eof: true }
  ]);
  assert.equal(readStdinSync(0, { readImpl, sleep: noopSleep, maxEagainRetries: 1 }), "AABB");
});

test("readStdinSync gives up after the bounded EAGAIN retries without throwing or looping forever", () => {
  let calls = 0;
  const readImpl = () => {
    calls += 1;
    const err = new Error("EWOULDBLOCK");
    err.code = "EWOULDBLOCK";
    throw err;
  };
  const raw = readStdinSync(0, { readImpl, sleep: noopSleep, maxEagainRetries: 3 });
  assert.equal(raw, "");
  assert.ok(calls <= 5, `bounded retry must stop quickly; got ${calls} calls`);
});

test("readHookInput parses the JSON payload into an object", () => {
  const readImpl = scriptedRead([{ data: '{"hook_event_name":"SessionStart","session_id":"s1"}' }, { eof: true }]);
  assert.deepEqual(readHookInput({ readImpl, sleep: noopSleep }), {
    hook_event_name: "SessionStart",
    session_id: "s1"
  });
});

test("readHookInput returns {} for an empty pipe (immediate EOF)", () => {
  const readImpl = scriptedRead([{ eof: true }]);
  assert.deepEqual(readHookInput({ readImpl, sleep: noopSleep }), {});
});

test("readHookInput returns {} on malformed JSON instead of throwing", () => {
  const readImpl = scriptedRead([{ data: "not json at all" }, { eof: true }]);
  assert.deepEqual(readHookInput({ readImpl, sleep: noopSleep }), {});
});

test("readHookInput returns {} when stdin only ever yields EAGAIN", () => {
  const readImpl = () => {
    const err = new Error("EAGAIN");
    err.code = "EAGAIN";
    throw err;
  };
  assert.deepEqual(readHookInput({ readImpl, sleep: noopSleep, maxEagainRetries: 2 }), {});
});

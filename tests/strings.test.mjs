import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { stripAnsi } from "../plugins/codex/scripts/lib/strings.mjs";

const ESC = "\u001b";
const BEL = "\u0007";

test("stripAnsi removes a CSI colour sequence", () => {
  assert.equal(stripAnsi(`${ESC}[31mred${ESC}[0m`), "red");
});

test("stripAnsi removes an OSC sequence terminated by BEL", () => {
  assert.equal(stripAnsi(`${ESC}]0;window title${BEL}rest`), "rest");
});

test("stripAnsi removes an OSC hyperlink terminated by ST", () => {
  assert.equal(
    stripAnsi(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`),
    "link"
  );
});

test("stripAnsi removes bracketed-paste markers (200~/201~)", () => {
  assert.equal(stripAnsi(`${ESC}[200~pasted${ESC}[201~`), "pasted");
});

test("stripAnsi leaves plain JSON untouched", () => {
  const json = '{"method":"turn/started","params":{"a":1}}';
  assert.equal(stripAnsi(json), json);
});

test("stripAnsi does NOT touch the literal text backslash-u-001b (JSON-encoded escape)", () => {
  // Six literal chars: \ u 0 0 1 b — what a real ESC looks like once JSON-encoded.
  // stripAnsi only removes raw 0x1B sequences, so this printable ASCII must survive.
  const encoded = '{"text":"a\\u001bb"}';
  assert.equal(stripAnsi(encoded), encoded);
});

test("stripAnsi removes erase-line / cursor-move sequences and keeps surrounding text", () => {
  assert.equal(stripAnsi(`${ESC}[2K${ESC}[1Ghello`), "hello");
});

test("stripAnsi removes an UNTERMINATED OSC sequence (no BEL/ST before end of string)", () => {
  // A raw OSC opener with no terminator must be consumed whole, not left as a
  // dangling `8;;...` tail (the old regex required a terminator, so it only
  // stripped the 2-char ESC] and left the body behind).
  assert.equal(stripAnsi(`${ESC}]8;;https://example.com/no-terminator`), "");
  assert.equal(stripAnsi(`before${ESC}]0;title-with-no-term`), "before");
});

test("stripAnsi consumes many unterminated OSC sequences with bodies (no O(n^2), no dangling body)", () => {
  // Each `ESC] <body>` opener with no terminator used to fall through to the
  // 2-char Fe-escape branch (stripping only `ESC]`) and leave every body behind,
  // while the OSC branch's unbounded lazy scan re-walked to EOS per opener =>
  // quadratic. The bounded negated-class match removes opener+body in one step
  // (O(n)) and leaves nothing behind.
  const adversarial = `${ESC}]0;filler-body`.repeat(40_000);
  const startNs = process.hrtime.bigint();
  assert.equal(stripAnsi(adversarial), "");
  const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
  // Coarse linearity lock: the bounded negated-class match is ~1-3ms; the old
  // unbounded lazy OSC scan was ~4800ms on this input. A correct-but-quadratic
  // refactor would pass the equality assertion above but blow this ceiling. The
  // bound is deliberately generous (well above linear, far below quadratic) so it
  // does not flake under parallel-runner CPU contention.
  assert.ok(
    elapsedMs < 1000,
    `stripAnsi on ${adversarial.length} chars took ${elapsedMs.toFixed(1)}ms — expected linear (<1000ms), got a superlinear stall`
  );
});

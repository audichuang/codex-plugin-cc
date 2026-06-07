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

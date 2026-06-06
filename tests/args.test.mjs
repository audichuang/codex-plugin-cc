import test from "node:test";
import assert from "node:assert/strict";

import { splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

test("splitRawArgumentString keeps backslashes literal inside single quotes (POSIX)", () => {
  // Single quotes preserve everything literally, including backslashes.
  assert.deepEqual(splitRawArgumentString("'a\\b'"), ["a\\b"]);
  assert.deepEqual(splitRawArgumentString("'C:\\Users\\me'"), ["C:\\Users\\me"]);
});

test("splitRawArgumentString treats single-quoted whitespace as part of one token", () => {
  assert.deepEqual(splitRawArgumentString("'a b c'"), ["a b c"]);
});

test("splitRawArgumentString splits on unquoted whitespace and strips the matching quotes", () => {
  assert.deepEqual(splitRawArgumentString("--base main 'focus text'"), ["--base", "main", "focus text"]);
});

test("splitRawArgumentString still honours backslash escapes outside single quotes", () => {
  // An escaped space stays in the token rather than splitting it.
  assert.deepEqual(splitRawArgumentString("a\\ b"), ["a b"]);
});

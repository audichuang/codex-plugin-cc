import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { truncateToByteBudget } from "../plugins/codex/scripts/lib/strings.mjs";
import {
  buildAdversarialReviewPrompt,
  MAX_REVIEW_PROMPT_BYTES
} from "../plugins/codex/scripts/codex-companion.mjs";

const baseContext = (content) => ({
  target: { label: "working tree" },
  collectionGuidance: "Review the following changes.",
  content
});

test("truncateToByteBudget returns the input unchanged when it is within budget", () => {
  assert.equal(truncateToByteBudget("hello", 100), "hello");
});

test("truncateToByteBudget truncates ASCII to at most maxBytes", () => {
  const out = truncateToByteBudget("abcdefghij", 4);
  assert.equal(out, "abcd");
  assert.ok(Buffer.byteLength(out, "utf8") <= 4);
});

test("truncateToByteBudget never splits a multi-byte UTF-8 sequence", () => {
  // "中" is 3 bytes in UTF-8. A 7-byte budget lands inside the 3rd char.
  const input = "中中中"; // 9 bytes
  const out = truncateToByteBudget(input, 7);
  assert.ok(Buffer.byteLength(out, "utf8") <= 7);
  // result must be whole characters only (re-encoding round-trips cleanly)
  assert.equal(out, "中中"); // 6 bytes — the partial 3rd char is dropped, not split
  assert.ok(!out.includes("�"), "must not contain a replacement char from a split sequence");
});

test("truncateToByteBudget never splits a 4-byte emoji", () => {
  const input = "😀😀"; // each emoji is 4 bytes (surrogate pair); 8 bytes total
  const out = truncateToByteBudget(input, 6); // lands inside the 2nd emoji
  assert.equal(out, "😀");
  assert.ok(Buffer.byteLength(out, "utf8") <= 6);
});

test("truncateToByteBudget returns empty string for a non-positive budget", () => {
  assert.equal(truncateToByteBudget("anything", 0), "");
});

test("buildAdversarialReviewPrompt leaves a small review input intact", () => {
  const prompt = buildAdversarialReviewPrompt(baseContext("a tiny diff"), "focus here");
  assert.ok(prompt.includes("a tiny diff"));
  assert.ok(!/truncat/i.test(prompt), "small inputs must not be truncated");
});

test("buildAdversarialReviewPrompt caps even when the oversize is in the framing (huge focusText), not REVIEW_INPUT", () => {
  // Codex deep-review MAJOR: the cap only truncated REVIEW_INPUT. A huge USER_FOCUS
  // (focusText) lives in the template framing, so it inflated the rendered prompt
  // past the API hard limit even after REVIEW_INPUT was emptied. A final backstop
  // must guarantee the WHOLE rendered prompt fits the budget.
  const hugeFocus = "x".repeat(1_200_000); // ~1.2 MB of focus text alone
  const prompt = buildAdversarialReviewPrompt(baseContext("a tiny diff"), hugeFocus);
  const bytes = Buffer.byteLength(prompt, "utf8");
  assert.ok(bytes <= MAX_REVIEW_PROMPT_BYTES, `framing-driven oversize must still fit; got ${bytes} > ${MAX_REVIEW_PROMPT_BYTES}`);
});

test("buildAdversarialReviewPrompt caps an oversized prompt to a valid-UTF-8 budget with a notice", () => {
  // ~2 MB of multi-byte content — well over the ~1 MB Codex input hard limit.
  const huge = "中".repeat(700_000); // 3 bytes each ≈ 2.1 MB
  const prompt = buildAdversarialReviewPrompt(baseContext(huge), "");
  const bytes = Buffer.byteLength(prompt, "utf8");
  assert.ok(bytes <= MAX_REVIEW_PROMPT_BYTES, `prompt must fit the budget; got ${bytes} > ${MAX_REVIEW_PROMPT_BYTES}`);
  // valid UTF-8: re-encoding round-trips with no replacement char
  assert.ok(!prompt.includes("�"), "truncation must not split a multi-byte char");
  assert.match(prompt, /truncat/i, "an oversized prompt must carry a truncation notice");
});

// Shared string utilities for the Codex plugin.

const ESC = String.fromCharCode(0x1b); // ESC (0x1B)
const BEL = String.fromCharCode(0x07); // BEL (0x07)

// ECMA-48 terminal escape sequences. Built from the raw ESC/BEL bytes so the
// pattern only ever matches *real* control bytes — a JSON-encoded escape (the
// six printable chars backslash-u-0-0-1-b) is left untouched, so stripping a
// JSONL line before parsing never corrupts an escape inside a string value.
//
// Alternation is ordered: OSC (terminated by BEL or ST) and CSI (the colour /
// cursor / bracketed-paste 200~/201~ family) are matched before the catch-all
// two-char Fe escape, so well-formed sequences are consumed whole.
const ANSI_PATTERN = new RegExp(
  [
    // OSC: ESC ] <body> optionally terminated by BEL or ST (ESC \). The body is a
    // bounded negated class [^BEL ESC]* (stops at the first BEL or the ESC that
    // begins ST) rather than an unbounded lazy `[\s\S]*?` that re-walks to EOS on
    // every unterminated opener — that lazy form is O(n^2) on a line carrying many
    // raw ESC] openers with no terminator. The trailing terminator is optional so
    // an unterminated opener is still consumed whole (opener + body) in one match.
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`,
    // CSI: ESC [ <params 0x30-0x3F> <intermediates 0x20-0x2F> <final 0x40-0x7E>
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    // Any other two-char Fe escape: ESC followed by a single byte 0x40-0x5F
    `${ESC}[@-_]`
  ].join("|"),
  "g"
);

/**
 * Remove ANSI/terminal escape sequences from a string.
 * @param {string} value
 * @returns {string}
 */
export function stripAnsi(value) {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }
  return value.replace(ANSI_PATTERN, "");
}

/**
 * Truncate a string to at most maxBytes of UTF-8 WITHOUT splitting a multi-byte
 * sequence — the cut backs off over any trailing continuation bytes (0x80-0xBF)
 * so the result is always valid UTF-8. Used to keep a rendered prompt under the
 * Codex API input limit.
 * @param {string} value
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateToByteBudget(value, maxBytes) {
  if (typeof value !== "string" || !(maxBytes > 0)) {
    return "";
  }
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) {
    return value;
  }
  let end = maxBytes;
  // buf[end] is the first byte that would be excluded. If it is a UTF-8
  // continuation byte (10xxxxxx) we are mid-sequence; back off until the cut
  // lands on a sequence boundary (a lead/ASCII byte or the start).
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}

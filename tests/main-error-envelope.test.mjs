import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { run } from "./helpers.mjs";
import { buildMainErrorEnvelope } from "../plugins/codex/scripts/codex-companion.mjs";

const COMPANION = path.resolve(
  fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url))
);

test("buildMainErrorEnvelope wraps an Error into a structured stdout envelope", () => {
  assert.deepEqual(buildMainErrorEnvelope(new Error("boom")), {
    status: "error",
    error: "boom",
    exitCode: 1
  });
});

test("buildMainErrorEnvelope stringifies a non-Error value", () => {
  assert.deepEqual(buildMainErrorEnvelope("plain string failure"), {
    status: "error",
    error: "plain string failure",
    exitCode: 1
  });
});

test("a failing companion run emits a JSON error envelope on stdout (visible to the rescue subagent)", () => {
  // The codex-rescue subagent captures stdout only; a stderr-only failure is
  // invisible to it. An unknown subcommand throws in main() before any handler.
  const result = run("node", [COMPANION, "definitely-not-a-subcommand"], { env: { ...process.env } });
  assert.equal(result.status, 1, "a failed run must exit non-zero");

  const stdoutLine = result.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  const envelope = JSON.parse(stdoutLine);
  assert.equal(envelope.status, "error");
  assert.match(envelope.error, /Unknown subcommand/i);
  assert.equal(envelope.exitCode, 1);

  // stderr still carries the human-readable message.
  assert.match(result.stderr, /Unknown subcommand/i);
});

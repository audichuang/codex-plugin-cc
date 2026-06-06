import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

// Importing helpers triggers the CLAUDE_PLUGIN_DATA isolation side-effect.
import "./helpers.mjs";

test("the test harness isolates CLAUDE_PLUGIN_DATA to a throwaway dir (never the real plugin data)", () => {
  const dir = process.env.CLAUDE_PLUGIN_DATA;
  assert.ok(dir, "CLAUDE_PLUGIN_DATA must be set by the harness");
  assert.ok(dir.startsWith(os.tmpdir()), `expected a tmp dir, got: ${dir}`);
  assert.doesNotMatch(
    dir,
    /\.claude[\\/]plugins[\\/]data/,
    "must not point at the developer's real plugin data dir — tests would collide with real broker/job state"
  );
});

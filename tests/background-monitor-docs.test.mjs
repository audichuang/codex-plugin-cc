import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("execute-plan background flow documents the signal-file Monitor + PushNotification handoff", () => {
  const source = read("commands/execute-plan.md");
  assert.match(source, /signalFile/);
  assert.match(source, /Monitor/);
  assert.match(source, /until \[ -f/);
  assert.match(source, /PushNotification/);
});

test("status command documents the liveness watchdog", () => {
  const source = read("commands/status.md");
  assert.match(source, /watchdog/i);
});

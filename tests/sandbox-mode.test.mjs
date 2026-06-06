import test from "node:test";
import assert from "node:assert/strict";

import { resolveSandboxMode } from "../plugins/codex/scripts/lib/codex.mjs";

function withEnv(value, fn) {
  const prev = process.env.CODEX_SANDBOX_MODE;
  try {
    if (value === undefined) {
      delete process.env.CODEX_SANDBOX_MODE;
    } else {
      process.env.CODEX_SANDBOX_MODE = value;
    }
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env.CODEX_SANDBOX_MODE;
    } else {
      process.env.CODEX_SANDBOX_MODE = prev;
    }
  }
}

test("resolveSandboxMode keeps the requested mode when CODEX_SANDBOX_MODE is unset", () => {
  withEnv(undefined, () => {
    assert.equal(resolveSandboxMode("read-only"), "read-only");
    assert.equal(resolveSandboxMode("workspace-write"), "workspace-write");
    assert.equal(resolveSandboxMode(undefined), "read-only");
  });
});

test("resolveSandboxMode lets CODEX_SANDBOX_MODE force the mode (for hosts that can't run Codex's bwrap sandbox)", () => {
  withEnv("danger-full-access", () => {
    assert.equal(resolveSandboxMode("read-only"), "danger-full-access");
    assert.equal(resolveSandboxMode("workspace-write"), "danger-full-access");
    assert.equal(resolveSandboxMode(undefined), "danger-full-access");
  });
});

test("resolveSandboxMode ignores a blank CODEX_SANDBOX_MODE", () => {
  withEnv("   ", () => {
    assert.equal(resolveSandboxMode("read-only"), "read-only");
  });
});

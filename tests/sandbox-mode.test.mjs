import "./helpers.mjs"; // hermetic isolation: drops ambient CODEX_* (incl. CODEX_SANDBOX_MODE)
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

test("resolveSandboxMode is hardcoded to danger-full-access by default (bwrap can't start on this fork's hosts)", () => {
  withEnv(undefined, () => {
    // The per-thread requested mode is intentionally ignored — bwrap modes
    // (read-only/workspace-write) fail on these hosts, so we always skip bwrap.
    assert.equal(resolveSandboxMode("read-only"), "danger-full-access");
    assert.equal(resolveSandboxMode("workspace-write"), "danger-full-access");
    assert.equal(resolveSandboxMode(undefined), "danger-full-access");
  });
});

test("resolveSandboxMode still lets CODEX_SANDBOX_MODE override the hardcoded default", () => {
  withEnv("read-only", () => {
    assert.equal(resolveSandboxMode("workspace-write"), "read-only");
    assert.equal(resolveSandboxMode(undefined), "read-only");
  });
  withEnv("danger-full-access", () => {
    assert.equal(resolveSandboxMode("read-only"), "danger-full-access");
  });
});

test("resolveSandboxMode ignores a blank CODEX_SANDBOX_MODE and falls back to the hardcoded default", () => {
  withEnv("   ", () => {
    assert.equal(resolveSandboxMode("read-only"), "danger-full-access");
  });
});

test("resolveSandboxMode rejects an invalid CODEX_SANDBOX_MODE (typo) and warns, instead of forwarding it verbatim", () => {
  withEnv("readonly", () => {
    const warnings = [];
    // A typo must NOT be forwarded to the app-server (which would fail thread/start
    // with an opaque deserialization error); fall back to the default and warn.
    assert.equal(resolveSandboxMode("read-only", { warn: (m) => warnings.push(m) }), "danger-full-access");
    assert.equal(warnings.length, 1, "an invalid override should warn exactly once");
    assert.match(warnings[0], /readonly/, "the warning should name the offending value");
  });
  withEnv("read_only", () => {
    assert.equal(resolveSandboxMode("read-only", { warn: () => {} }), "danger-full-access");
  });
});

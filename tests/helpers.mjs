import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

// Hermetic state isolation. state.mjs resolves its per-workspace state dir under
// CLAUDE_PLUGIN_DATA; if that points at the developer's real plugin data
// (~/.claude/plugins/data/...), tests write broker.json/state.json there and
// spawn brokers that collide with real Codex runs in this repo — the source of
// the "Shared Codex broker is busy" setup-test flakes and the stray test brokers
// left behind. Redirect it to a throwaway dir for the whole test process. Both
// the test process and any companion subprocess (buildEnv spreads process.env)
// then share this isolated root, and `node --test` runs each file in its own
// process, so this is per-file isolation. Tests that exercise CLAUDE_PLUGIN_DATA
// directly (state.test.mjs) still save/restore around their own changes.
process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-data-"));

// Also redirect HOME (and USERPROFILE on Windows) to a throwaway dir. state.mjs's
// collectCandidateStateRoots defaults its homedir to os.homedir() and walks
// ~/.claude/plugins/data for codex* state dirs during cross-workspace lookups; if
// HOME points at the developer's real home, those lookups read real on-disk job
// files (a hermeticity breach and a flake source). os.homedir() honors $HOME on
// POSIX and %USERPROFILE% on Windows, so redirecting both neutralizes the walk.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-home-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

// Also drop ambient CODEX_* knobs from the test process itself (buildEnv already
// does this for spawned companions). Otherwise an ambient CODEX_COMPANION_SESSION_ID
// makes in-process, session-filtered status/result reads see "no jobs", and
// tuning knobs (CODEX_JOB_TIMEOUT_MS, watchdog intervals) make timing
// nondeterministic. Tests that need any of these set them explicitly.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("CODEX_")) {
    delete process.env[key];
  }
}

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: process.platform === "win32" && !path.isAbsolute(command),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}

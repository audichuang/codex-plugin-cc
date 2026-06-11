# delegate-plugin-cc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一個 Claude Code plugin（`delegate`），把主 session 想好的任務委派給「便宜模型驅動的 headless `claude -p`」執行，profile（標準 settings.json 檔）切換模型/端點，env 完全重建隔離。

**Architecture:** 無 broker 的 lean spawn 架構。`commands/*.md` 薄殼 → `delegate-companion.mjs` CLI → spawn `claude -p --settings <profile> --output-format stream-json`，prompt 走 stdin。背景任務：per-job JSON 為真相來源 + O_EXCL `.lock` CAS 終態 + detached worker + in-process timeout。規格：`codex-plugin-cc/docs/superpowers/specs/2026-06-11-delegate-plugin-cc-design.md`。

**Tech Stack:** Node.js ≥20（ESM `.mjs`、`node --test`）、零 runtime 依賴。

**工作目錄：所有任務在新 repo `/home/audichuang/research/delegate-plugin-cc` 執行**（Task 1 建立它）。測試指令一律在該 repo 根目錄跑。

**對規格的已核准簡化：** 規格 §5 提到 `state.json` 衍生索引 — MVP 省略（jobs 上限 50，直接掃目錄即可），per-job JSON 仍是唯一真相來源。

---

### Task 1: Repo 骨架 + manifests + hermetic 測試 helpers

**Files:**
- Create: `/home/audichuang/research/delegate-plugin-cc/package.json`
- Create: `/home/audichuang/research/delegate-plugin-cc/.gitignore`
- Create: `/home/audichuang/research/delegate-plugin-cc/.claude-plugin/marketplace.json`
- Create: `/home/audichuang/research/delegate-plugin-cc/plugins/delegate/.claude-plugin/plugin.json`
- Create: `/home/audichuang/research/delegate-plugin-cc/tests/helpers.mjs`

- [ ] **Step 1: 建 repo 與目錄**

```bash
mkdir -p /home/audichuang/research/delegate-plugin-cc
cd /home/audichuang/research/delegate-plugin-cc
git init
mkdir -p .claude-plugin plugins/delegate/.claude-plugin plugins/delegate/commands plugins/delegate/scripts/lib tests
```

- [ ] **Step 2: 寫 `package.json`**

```json
{
  "name": "delegate-plugin-cc",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Delegate tasks from Claude Code to cheap-model headless Claude Code instances via settings profiles",
  "scripts": {
    "test": "node --test tests/*.test.mjs"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 3: 寫 `.gitignore`**

```
node_modules/
*.log
```

- [ ] **Step 4: 寫 `.claude-plugin/marketplace.json`**

（欄位格式以 `/home/audichuang/research/codex-plugin-cc/.claude-plugin/marketplace.json` 為準 — 開工時先 `cat` 它對照，僅換掉名稱/描述/路徑。）

```json
{
  "name": "claude-delegate",
  "owner": { "name": "audichuang" },
  "plugins": [
    {
      "name": "delegate",
      "source": "./plugins/delegate",
      "description": "Delegate execution tasks to cheap-model headless Claude Code via settings profiles",
      "version": "0.1.0"
    }
  ]
}
```

- [ ] **Step 5: 寫 `plugins/delegate/.claude-plugin/plugin.json`**

（同樣以 codex-plugin-cc 的 `plugins/codex/.claude-plugin/plugin.json` 為格式基準。）

```json
{
  "name": "delegate",
  "version": "0.1.0",
  "description": "Delegate execution tasks to cheap-model headless Claude Code via settings profiles"
}
```

- [ ] **Step 6: 寫 `tests/helpers.mjs`（hermetic 基座 — 每個測試檔第一個 import 必須是它）**

```js
// Hermetic test base: import this FIRST in every test file.
// Redirects HOME/data dirs to throwaway temp dirs and strips ambient
// ANTHROPIC_*/CLAUDE_*/CLAUDECODE*/DELEGATE_* so the suite never reads the
// real ~/.claude and never inherits the developer's provider env.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-test-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("ANTHROPIC_") ||
    key.startsWith("CLAUDE_") ||
    key.startsWith("CLAUDECODE") ||
    key.startsWith("DELEGATE_")
  ) {
    delete process.env[key];
  }
}
process.env.DELEGATE_PLUGIN_DATA = fs.mkdtempSync(
  path.join(os.tmpdir(), "delegate-test-data-"),
);

export function makeTempDir(prefix = "delegate-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeDataRoot() {
  return makeTempDir("delegate-data-");
}

export function writeProfile(dataRoot, name, contents) {
  const dir = path.join(dataRoot, "profiles");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(contents, null, 2));
  return file;
}
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold delegate-plugin-cc (manifests, hermetic test base)"
```

---

### Task 2: `args.mjs` — 極簡旗標解析

**Files:**
- Create: `plugins/delegate/scripts/lib/args.mjs`
- Test: `tests/args.test.mjs`

- [ ] **Step 1: 寫失敗測試 `tests/args.test.mjs`**

```js
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, UsageError } from "../plugins/delegate/scripts/lib/args.mjs";

test("parses value flags, bool flags, and positionals", () => {
  const { flags, positionals } = parseArgs(
    ["fix", "the", "bug", "--profile", "kimi", "--background"],
    { valueFlags: ["profile"], boolFlags: ["background"] },
  );
  assert.equal(flags.profile, "kimi");
  assert.equal(flags.background, true);
  assert.deepEqual(positionals, ["fix", "the", "bug"]);
});

test("-- stops flag parsing", () => {
  const { flags, positionals } = parseArgs(["--", "--profile", "x"], {
    valueFlags: ["profile"],
  });
  assert.deepEqual(flags, {});
  assert.deepEqual(positionals, ["--profile", "x"]);
});

test("unknown flag throws UsageError", () => {
  assert.throws(() => parseArgs(["--nope"], {}), UsageError);
});

test("value flag missing its value throws UsageError", () => {
  assert.throws(
    () => parseArgs(["--profile"], { valueFlags: ["profile"] }),
    UsageError,
  );
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test`
Expected: FAIL（`Cannot find module .../args.mjs`）

- [ ] **Step 3: 寫 `plugins/delegate/scripts/lib/args.mjs`**

```js
export class UsageError extends Error {}

export function parseArgs(argv, { valueFlags = [], boolFlags = [] } = {}) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (boolFlags.includes(name)) {
        flags[name] = true;
        continue;
      }
      if (valueFlags.includes(name)) {
        const value = argv[++i];
        if (value === undefined) {
          throw new UsageError(`Flag --${name} requires a value`);
        }
        flags[name] = value;
        continue;
      }
      throw new UsageError(`Unknown flag: --${name}`);
    }
    positionals.push(token);
  }
  return { flags, positionals };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: minimal flag parser (args.mjs)"
```

---

### Task 3: `env.mjs` — 環境重建（規格 §7 的核心）

**Files:**
- Create: `plugins/delegate/scripts/lib/env.mjs`
- Test: `tests/env.test.mjs`

- [ ] **Step 1: 寫失敗測試 `tests/env.test.mjs`**

```js
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildDelegateEnv } from "../plugins/delegate/scripts/lib/env.mjs";

test("strips main-session provider/runtime vars (the polluted-env case)", () => {
  const env = buildDelegateEnv({
    baseEnv: {
      PATH: "/usr/bin",
      HOME: "/home/u",
      ANTHROPIC_BASE_URL: "https://expensive.example.com",
      ANTHROPIC_AUTH_TOKEN: "main-secret",
      ANTHROPIC_MODEL: "opus",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_PLUGIN_DATA: "/somewhere",
      CLAUDECODE: "1",
    },
    profileEnv: {},
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/u");
  for (const key of Object.keys(env)) {
    assert.ok(!key.startsWith("ANTHROPIC_"), `leaked ${key}`);
    assert.ok(!key.startsWith("CLAUDECODE"), `leaked ${key}`);
    assert.ok(
      !key.startsWith("CLAUDE_") || key === "CLAUDE_DELEGATE_ACTIVE",
      `leaked ${key}`,
    );
  }
});

test("injects profile env verbatim and wins over base", () => {
  const env = buildDelegateEnv({
    baseEnv: { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://expensive" },
    profileEnv: {
      ANTHROPIC_BASE_URL: "https://cheap.example.com",
      ANTHROPIC_AUTH_TOKEN: "kimi-token",
    },
  });
  assert.equal(env.ANTHROPIC_BASE_URL, "https://cheap.example.com");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "kimi-token");
});

test("always sets the recursion marker", () => {
  const env = buildDelegateEnv({ baseEnv: {}, profileEnv: {} });
  assert.equal(env.CLAUDE_DELEGATE_ACTIVE, "1");
});

test("non-string profile env values are ignored", () => {
  const env = buildDelegateEnv({
    baseEnv: {},
    profileEnv: { GOOD: "x", BAD: 42, WORSE: null },
  });
  assert.equal(env.GOOD, "x");
  assert.ok(!("BAD" in env));
  assert.ok(!("WORSE" in env));
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test`
Expected: FAIL（module not found）

- [ ] **Step 3: 寫 `plugins/delegate/scripts/lib/env.mjs`**

```js
// Spec §7: the delegate env is REBUILT, never inherited. Strip every
// main-session provider/runtime var, then inject the profile's env block as
// real process env (belt-and-suspenders vs settings precedence), then add the
// recursion marker. Same trick as claudecode-telegram's clean_env, extended.
const DENY_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "CLAUDECODE"];

export const RECURSION_MARKER = "CLAUDE_DELEGATE_ACTIVE";

export function buildDelegateEnv({ baseEnv = process.env, profileEnv = {} } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (DENY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(profileEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  env[RECURSION_MARKER] = "1";
  return env;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: delegate env rebuild — strip provider vars, inject profile env (spec §7)"
```

---

### Task 4: `profiles.mjs` — profile 解析與驗證

**Files:**
- Create: `plugins/delegate/scripts/lib/profiles.mjs`
- Test: `tests/profiles.test.mjs`

- [ ] **Step 1: 寫失敗測試 `tests/profiles.test.mjs`**

```js
import { makeDataRoot, writeProfile } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  listProfiles,
  resolveProfile,
  ProfileError,
} from "../plugins/delegate/scripts/lib/profiles.mjs";

test("listProfiles returns sorted names, empty when dir missing", () => {
  const dataRoot = makeDataRoot();
  assert.deepEqual(listProfiles(dataRoot), []);
  writeProfile(dataRoot, "kimi", { env: {} });
  writeProfile(dataRoot, "glm", { env: {} });
  assert.deepEqual(listProfiles(dataRoot), ["glm", "kimi"]);
});

test("resolveProfile by name loads env block and path", () => {
  const dataRoot = makeDataRoot();
  const file = writeProfile(dataRoot, "kimi", {
    env: { ANTHROPIC_BASE_URL: "https://cheap" },
    model: "kimi-k2",
  });
  const profile = resolveProfile({ dataRoot, profile: "kimi", env: {} });
  assert.equal(profile.name, "kimi");
  assert.equal(profile.path, file);
  assert.equal(profile.env.ANTHROPIC_BASE_URL, "https://cheap");
});

test("falls back to DELEGATE_DEFAULT_PROFILE", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "glm", { env: {} });
  const profile = resolveProfile({
    dataRoot,
    env: { DELEGATE_DEFAULT_PROFILE: "glm" },
  });
  assert.equal(profile.name, "glm");
});

test("no profile and no default → ProfileError listing available", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "kimi", { env: {} });
  assert.throws(
    () => resolveProfile({ dataRoot, env: {} }),
    (error) => error instanceof ProfileError && /kimi/.test(error.message),
  );
});

test("missing file and invalid JSON → ProfileError (fail fast, pre-spawn)", () => {
  const dataRoot = makeDataRoot();
  assert.throws(
    () => resolveProfile({ dataRoot, profile: "nope", env: {} }),
    ProfileError,
  );
  const bad = writeProfile(dataRoot, "bad", {});
  // 蓋成壞 JSON
  (await import("node:fs")).default.writeFileSync(bad, "{not json");
  assert.throws(
    () => resolveProfile({ dataRoot, profile: "bad", env: {} }),
    (error) => error instanceof ProfileError && /not valid JSON/.test(error.message),
  );
});

test("explicit settingsPath bypasses the profiles dir", async () => {
  const fs = (await import("node:fs")).default;
  const path = (await import("node:path")).default;
  const dataRoot = makeDataRoot();
  const file = path.join(dataRoot, "anywhere.json");
  fs.writeFileSync(file, JSON.stringify({ env: { A: "1" } }));
  const profile = resolveProfile({ dataRoot, settingsPath: file, env: {} });
  assert.equal(profile.env.A, "1");
});
```

注意：上面 `missing file and invalid JSON` 測試裡用了 `await import` — 該 test callback 要宣告成 `async`。寫的時候直接把兩個用到 `await import` 的 test 都標 `async`。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test`
Expected: FAIL（module not found）

- [ ] **Step 3: 寫 `plugins/delegate/scripts/lib/profiles.mjs`**

```js
import fs from "node:fs";
import path from "node:path";

export class ProfileError extends Error {}

export function profilesDir(dataRoot) {
  return path.join(dataRoot, "profiles");
}

export function listProfiles(dataRoot) {
  let entries;
  try {
    entries = fs.readdirSync(profilesDir(dataRoot));
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

function loadProfileFile(file, name) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new ProfileError(`Profile "${name}" not found at ${file}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProfileError(`Profile "${name}" is not valid JSON: ${file}`);
  }
  const env =
    parsed && typeof parsed.env === "object" && parsed.env !== null
      ? parsed.env
      : {};
  return { name, path: file, env, settings: parsed };
}

export function resolveProfile({ dataRoot, profile, settingsPath, env = process.env } = {}) {
  if (settingsPath) {
    const abs = path.resolve(settingsPath);
    return loadProfileFile(abs, path.basename(abs, ".json"));
  }
  const name = profile ?? env.DELEGATE_DEFAULT_PROFILE;
  if (!name) {
    const available = listProfiles(dataRoot);
    throw new ProfileError(
      available.length
        ? `No profile specified. Use --profile <name> or set DELEGATE_DEFAULT_PROFILE. Available: ${available.join(", ")}`
        : `No profile specified and none exist. Create one at ${profilesDir(dataRoot)}/<name>.json (standard Claude Code settings format).`,
    );
  }
  return loadProfileFile(path.join(profilesDir(dataRoot), `${name}.json`), name);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: profile resolution — name/default/explicit-path, fail-fast validation"
```

---

### Task 5: `state.mjs` — per-job JSON、atomic write、CAS 終態、prune

**Files:**
- Create: `plugins/delegate/scripts/lib/state.mjs`
- Test: `tests/state.test.mjs`

- [ ] **Step 1: 寫失敗測試 `tests/state.test.mjs`**

```js
import { makeTempDir } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  resolveDataRoot,
  workspaceStateDir,
  newJobId,
  writeJob,
  readJob,
  listJobs,
  finalizeJob,
  pruneJobs,
  jobFilePath,
  promptFilePath,
  logFilePath,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
} from "../plugins/delegate/scripts/lib/state.mjs";

test("resolveDataRoot prefers DELEGATE_PLUGIN_DATA then CLAUDE_PLUGIN_DATA", () => {
  assert.equal(resolveDataRoot({ DELEGATE_PLUGIN_DATA: "/a", CLAUDE_PLUGIN_DATA: "/b" }), "/a");
  assert.equal(resolveDataRoot({ CLAUDE_PLUGIN_DATA: "/b" }), "/b");
  assert.ok(resolveDataRoot({}).includes(".claude"));
});

test("workspaceStateDir is stable per cwd and collision-resistant", () => {
  const root = makeTempDir();
  const a = workspaceStateDir(root, "/home/u/proj");
  const b = workspaceStateDir(root, "/home/u/proj");
  const c = workspaceStateDir(root, "/home/other/proj");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("write/read/list jobs round-trips and sorts newest first", () => {
  const stateDir = makeTempDir();
  const j1 = { id: newJobId(1000), status: "queued", createdAt: "2026-01-01T00:00:00Z" };
  const j2 = { id: newJobId(2000), status: "queued", createdAt: "2026-01-02T00:00:00Z" };
  writeJob(stateDir, j1);
  writeJob(stateDir, j2);
  assert.equal(readJob(stateDir, j1.id).id, j1.id);
  assert.equal(readJob(stateDir, "missing"), null);
  const listed = listJobs(stateDir);
  assert.deepEqual(listed.map((j) => j.id), [j2.id, j1.id]);
  assert.ok(listed[0].updatedAt, "writeJob stamps updatedAt");
});

test("finalizeJob: first terminal writer wins (CAS)", () => {
  const stateDir = makeTempDir();
  const job = { id: newJobId(), status: "running", createdAt: "2026-01-01T00:00:00Z" };
  writeJob(stateDir, job);
  assert.equal(finalizeJob(stateDir, job.id, { status: "completed" }), true);
  assert.equal(finalizeJob(stateDir, job.id, { status: "cancelled" }), false);
  assert.equal(readJob(stateDir, job.id).status, "completed");
});

test("corrupt job file is skipped by listJobs, not fatal", () => {
  const stateDir = makeTempDir();
  const job = { id: newJobId(), status: "queued", createdAt: "x" };
  writeJob(stateDir, job);
  fs.writeFileSync(path.join(stateDir, "jobs", "broken.json"), "{nope");
  assert.equal(listJobs(stateDir).length, 1);
});

test("pruneJobs caps terminal jobs but never evicts active ones", () => {
  const stateDir = makeTempDir();
  for (let i = 0; i < 6; i++) {
    const id = `dlg-prune-${i}`;
    writeJob(stateDir, {
      id,
      status: i < 2 ? "running" : "completed",
      createdAt: `2026-01-0${i + 1}T00:00:00Z`,
    });
  }
  pruneJobs(stateDir, { max: 3 });
  const remaining = listJobs(stateDir);
  const running = remaining.filter((j) => j.status === "running");
  assert.equal(running.length, 2, "active jobs survive");
  assert.ok(remaining.length <= 3);
});

test("status sets are disjoint and cover the lifecycle", () => {
  for (const s of ACTIVE_STATUSES) assert.ok(!TERMINAL_STATUSES.has(s));
  assert.ok(TERMINAL_STATUSES.has("completed"));
  assert.ok(TERMINAL_STATUSES.has("timed-out"));
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test`
Expected: FAIL（module not found）

- [ ] **Step 3: 寫 `plugins/delegate/scripts/lib/state.mjs`**

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const ACTIVE_STATUSES = new Set(["queued", "running"]);
export const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed-out",
]);

export function resolveDataRoot(env = process.env) {
  if (env.DELEGATE_PLUGIN_DATA) return env.DELEGATE_PLUGIN_DATA;
  if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
  return path.join(os.homedir(), ".claude", "plugins", "data", "delegate");
}

export function workspaceStateDir(dataRoot, cwd) {
  const slug =
    path.basename(cwd).replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 32) || "ws";
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return path.join(dataRoot, "state", `${slug}-${hash}`);
}

export function jobsDir(stateDir) {
  return path.join(stateDir, "jobs");
}
export function jobFilePath(stateDir, jobId) {
  return path.join(jobsDir(stateDir), `${jobId}.json`);
}
export function promptFilePath(stateDir, jobId) {
  return path.join(jobsDir(stateDir), `${jobId}.prompt.txt`);
}
export function logFilePath(stateDir, jobId) {
  return path.join(jobsDir(stateDir), `${jobId}.log`);
}
function lockFilePath(stateDir, jobId) {
  return jobFilePath(stateDir, jobId) + ".lock";
}

export function newJobId(now = Date.now()) {
  return `dlg-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function writeJob(stateDir, job) {
  writeJsonAtomic(jobFilePath(stateDir, job.id), {
    ...job,
    updatedAt: new Date().toISOString(),
  });
}

export function readJob(stateDir, jobId) {
  try {
    return JSON.parse(fs.readFileSync(jobFilePath(stateDir, jobId), "utf8"));
  } catch {
    return null;
  }
}

export function listJobs(stateDir) {
  let entries;
  try {
    entries = fs.readdirSync(jobsDir(stateDir));
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      jobs.push(JSON.parse(fs.readFileSync(path.join(jobsDir(stateDir), name), "utf8")));
    } catch {
      // corrupt/in-flight file — skip, never fatal
    }
  }
  return jobs.sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  );
}

// Cross-process CAS: O_EXCL lock file, first terminal writer wins.
function claimTerminalTransition(stateDir, jobId) {
  fs.mkdirSync(jobsDir(stateDir), { recursive: true });
  try {
    fs.writeFileSync(lockFilePath(stateDir, jobId), String(process.pid), {
      flag: "wx",
    });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

export function finalizeJob(stateDir, jobId, patch) {
  if (!TERMINAL_STATUSES.has(patch.status)) {
    throw new Error(`finalizeJob requires a terminal status, got ${patch.status}`);
  }
  if (!claimTerminalTransition(stateDir, jobId)) return false;
  const job = readJob(stateDir, jobId) ?? { id: jobId };
  writeJob(stateDir, { ...job, ...patch });
  return true;
}

export function pruneJobs(stateDir, { max = 50 } = {}) {
  const jobs = listJobs(stateDir);
  const activeCount = jobs.filter((j) => ACTIVE_STATUSES.has(j.status)).length;
  const terminal = jobs
    .filter((j) => TERMINAL_STATUSES.has(j.status))
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  const keep = Math.max(0, max - activeCount);
  for (const job of terminal.slice(keep)) {
    for (const file of [
      jobFilePath(stateDir, job.id),
      lockFilePath(stateDir, job.id),
      promptFilePath(stateDir, job.id),
      logFilePath(stateDir, job.id),
    ]) {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: job state — per-job JSON truth, atomic writes, O_EXCL terminal CAS, active-safe prune"
```

---

### Task 6: `job-control.mjs` — 死 PID 和解、cancel（CAS 先於 kill）

**Files:**
- Create: `plugins/delegate/scripts/lib/job-control.mjs`
- Test: `tests/job-control.test.mjs`

- [ ] **Step 1: 寫失敗測試 `tests/job-control.test.mjs`**

```js
import { makeTempDir } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileDeadPids,
  cancelJob,
} from "../plugins/delegate/scripts/lib/job-control.mjs";
import {
  writeJob,
  readJob,
  finalizeJob,
} from "../plugins/delegate/scripts/lib/state.mjs";

test("reconcileDeadPids fails running jobs whose pid is gone", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-dead", status: "running", pid: 99999, createdAt: "a" });
  writeJob(stateDir, { id: "dlg-live", status: "running", pid: 11111, createdAt: "b" });
  const reconciled = reconcileDeadPids(stateDir, {
    isAlive: (pid) => pid === 11111,
  });
  assert.deepEqual(reconciled, ["dlg-dead"]);
  assert.equal(readJob(stateDir, "dlg-dead").status, "failed");
  assert.equal(readJob(stateDir, "dlg-live").status, "running");
});

test("cancelJob claims terminal BEFORE signalling, and never signals a finalized job", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-c1", status: "running", pid: 4242, createdAt: "a" });
  const killed = [];
  const r1 = cancelJob(stateDir, "dlg-c1", {
    isAlive: () => true,
    killImpl: (pid, sig) => killed.push([pid, sig]),
  });
  assert.equal(r1.ok, true);
  assert.deepEqual(killed, [[4242, "SIGTERM"]]);
  assert.equal(readJob(stateDir, "dlg-c1").status, "cancelled");

  // 已終態的 job：不可再 kill
  writeJob(stateDir, { id: "dlg-c2", status: "running", pid: 4343, createdAt: "b" });
  finalizeJob(stateDir, "dlg-c2", { status: "completed" });
  const killed2 = [];
  const r2 = cancelJob(stateDir, "dlg-c2", {
    isAlive: () => true,
    killImpl: (pid, sig) => killed2.push([pid, sig]),
  });
  assert.equal(r2.ok, false);
  assert.deepEqual(killed2, [], "stale pid must never be signalled");
});

test("cancelJob on unknown job reports cleanly", () => {
  const stateDir = makeTempDir();
  const r = cancelJob(stateDir, "nope", { isAlive: () => true, killImpl: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.message, /No job/);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test`
Expected: FAIL（module not found）

- [ ] **Step 3: 寫 `plugins/delegate/scripts/lib/job-control.mjs`**

```js
import {
  listJobs,
  readJob,
  finalizeJob,
  TERMINAL_STATUSES,
} from "./state.mjs";

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function reconcileDeadPids(stateDir, deps = {}) {
  const isAlive = deps.isAlive ?? isPidAlive;
  const reconciled = [];
  for (const job of listJobs(stateDir)) {
    if (job.status !== "running" || !job.pid) continue;
    if (isAlive(job.pid)) continue;
    if (
      finalizeJob(stateDir, job.id, {
        status: "failed",
        error: "worker process died (reconciled dead pid)",
      })
    ) {
      reconciled.push(job.id);
    }
  }
  return reconciled;
}

// Order matters (lesson from codex-plugin-cc): consult the per-job file and
// claim the terminal transition FIRST; only the CAS winner may signal the pid.
// A loser must not signal — the pid may already be reused.
export function cancelJob(stateDir, jobId, deps = {}) {
  const isAlive = deps.isAlive ?? isPidAlive;
  const killImpl = deps.killImpl ?? ((pid, sig) => process.kill(pid, sig));
  const job = readJob(stateDir, jobId);
  if (!job) return { ok: false, message: `No job ${jobId} in this workspace.` };
  if (TERMINAL_STATUSES.has(job.status)) {
    return { ok: false, message: `Job ${jobId} already ${job.status}.` };
  }
  if (!finalizeJob(stateDir, jobId, { status: "cancelled" })) {
    const latest = readJob(stateDir, jobId);
    return {
      ok: false,
      message: `Job ${jobId} already ${latest?.status ?? "finalized"}.`,
    };
  }
  if (job.pid && isAlive(job.pid)) {
    try {
      killImpl(job.pid, "SIGTERM");
    } catch {}
  }
  return { ok: true, message: `Cancelled ${jobId}.` };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: job control — dead-pid reconcile, CAS-before-kill cancel"
```

---

### Task 7: fake-claude fixture + `claude.mjs`（spawn、stream-json 擷取、stdin、timeout、EPIPE）

**Files:**
- Create: `tests/fake-claude.mjs`
- Create: `plugins/delegate/scripts/lib/claude.mjs`
- Test: `tests/claude.test.mjs`

- [ ] **Step 1: 寫 `tests/fake-claude.mjs`（可腳本化的 claude 替身）**

```js
#!/usr/bin/env node
// Scriptable stand-in for the claude CLI (stream-json contract).
// FAKE_CLAUDE_MODE: success (default) | noise | fail | hang | early-exit
const mode = process.env.FAKE_CLAUDE_MODE ?? "success";
const sessionId = process.env.FAKE_CLAUDE_SESSION_ID ?? "sess-fake-1";

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (mode === "early-exit") {
  // Exit without ever reading stdin → parent gets EPIPE on a large prompt.
  process.exit(3);
}

let stdin = "";
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  out({ type: "system", subtype: "init", session_id: sessionId });
  if (mode === "noise") {
    process.stdout.write("WARNING: ansi-ish noise line\n");
    process.stdout.write("{broken json line\n");
  }
  if (mode === "fail") {
    process.stderr.write("API error: invalid auth token\n");
    process.exit(1);
  }
  if (mode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `echo:${stdin.trim().slice(0, 60)}`,
    session_id: sessionId,
  });
  process.exit(0);
});
```

- [ ] **Step 2: 寫失敗測試 `tests/claude.test.mjs`**

```js
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildClaudeArgs,
  runClaudeTurn,
  resolveTimeoutMs,
  DEFAULT_TIMEOUT_MS,
} from "../plugins/delegate/scripts/lib/claude.mjs";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fake-claude.mjs",
);

// 把 binary/args 替換成 node + fixture，其餘照舊 — runClaudeTurn 的 spawn seam。
function fakeSpawn(mode) {
  return (_binary, _args, options) =>
    spawn(process.execPath, [FIXTURE], {
      ...options,
      env: { ...options.env, FAKE_CLAUDE_MODE: mode },
    });
}

test("buildClaudeArgs composes the headless invocation", () => {
  const args = buildClaudeArgs({ settingsPath: "/p/kimi.json" });
  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    "/p/kimi.json",
    "--permission-mode",
    "bypassPermissions",
  ]);
  const resumed = buildClaudeArgs({
    settingsPath: "/p/kimi.json",
    permissionMode: "acceptEdits",
    resumeSessionId: "sess-9",
  });
  assert.ok(resumed.includes("acceptEdits"));
  assert.deepEqual(resumed.slice(-2), ["-r", "sess-9"]);
});

test("resolveTimeoutMs defaults to 1h, env-overridable", () => {
  assert.equal(resolveTimeoutMs({}), DEFAULT_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({ DELEGATE_JOB_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(resolveTimeoutMs({ DELEGATE_JOB_TIMEOUT_MS: "junk" }), DEFAULT_TIMEOUT_MS);
});

test("success: captures session id, result text, exit 0", async () => {
  const lines = [];
  const outcome = await runClaudeTurn({
    args: [],
    prompt: "hello world",
    env: {},
    spawnImpl: fakeSpawn("success"),
    onLine: (line) => lines.push(line),
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.sessionId, "sess-fake-1");
  assert.match(outcome.resultText, /^echo:hello world/);
  assert.equal(outcome.isError, false);
  assert.ok(lines.length >= 2, "raw lines streamed to onLine");
});

test("noise: non-JSON and broken-JSON lines are skipped, result still captured", async () => {
  const outcome = await runClaudeTurn({
    args: [],
    prompt: "x",
    env: {},
    spawnImpl: fakeSpawn("noise"),
  });
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.resultText, /^echo:/);
});

test("fail: nonzero exit with stderr tail captured", async () => {
  const outcome = await runClaudeTurn({
    args: [],
    prompt: "x",
    env: {},
    spawnImpl: fakeSpawn("fail"),
  });
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.stderrTail, /invalid auth token/);
});

test("hang: timeout escalates SIGTERM→SIGKILL and flags timedOut", async () => {
  const outcome = await runClaudeTurn({
    args: [],
    prompt: "x",
    env: {},
    timeoutMs: 300,
    graceMs: 200,
    spawnImpl: fakeSpawn("hang"),
  });
  assert.equal(outcome.timedOut, true);
  assert.notEqual(outcome.exitCode, 0);
});

test("early-exit: big prompt EPIPE is survived, recorded, not thrown", async () => {
  const outcome = await runClaudeTurn({
    args: [],
    prompt: "p".repeat(1024 * 1024),
    env: {},
    spawnImpl: fakeSpawn("early-exit"),
  });
  assert.equal(outcome.exitCode, 3);
  assert.ok(outcome.stdinError, "stdin error captured");
});

test("spawn failure (ENOENT) resolves as error outcome", async () => {
  const outcome = await runClaudeTurn({
    binary: "/definitely/not/a/binary",
    args: [],
    prompt: "x",
    env: {},
  });
  assert.equal(outcome.isError, true);
  assert.match(outcome.stderrTail, /ENOENT|not found/i);
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npm test`
Expected: FAIL（claude.mjs not found）

- [ ] **Step 4: 寫 `plugins/delegate/scripts/lib/claude.mjs`**

```js
import { spawn } from "node:child_process";
import readline from "node:readline";

export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1h, codex 版 1.0.18 對齊
const FORCE_KILL_GRACE_MS = 5000;
const STDERR_TAIL_BYTES = 4096;

export function resolveTimeoutMs(env = process.env) {
  const raw = Number(env.DELEGATE_JOB_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export function buildClaudeArgs({
  settingsPath,
  permissionMode = "bypassPermissions",
  resumeSessionId,
} = {}) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    settingsPath,
    "--permission-mode",
    permissionMode,
  ];
  if (resumeSessionId) args.push("-r", resumeSessionId);
  return args;
}

// Spawns one headless claude turn. Prompt goes through STDIN, never argv
// (argv leaks to `ps`; large prompts need EPIPE handling — an early-exiting
// child must fail the JOB, not crash the runner).
export function runClaudeTurn({
  binary = "claude",
  args,
  prompt,
  env,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  graceMs = FORCE_KILL_GRACE_MS,
  spawnImpl = spawn,
  onLine = () => {},
} = {}) {
  return new Promise((resolve) => {
    const outcome = {
      exitCode: null,
      signal: null,
      sessionId: null,
      resultText: null,
      isError: false,
      timedOut: false,
      stderrTail: "",
      stdinError: null,
    };
    let child;
    try {
      child = spawnImpl(binary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      outcome.isError = true;
      outcome.stderrTail = String(error?.message ?? error);
      resolve(outcome);
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      outcome.timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      const force = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, graceMs);
      force.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.stdin.on("error", (error) => {
      outcome.stdinError = error;
    });
    try {
      child.stdin.write(prompt ?? "");
      child.stdin.end();
    } catch (error) {
      outcome.stdinError = outcome.stdinError ?? error;
    }

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      onLine(line);
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return; // tolerate junk — never fail the turn on a noisy line
      }
      if (typeof event.session_id === "string" && !outcome.sessionId) {
        outcome.sessionId = event.session_id;
      }
      if (event.type === "result") {
        outcome.resultText =
          typeof event.result === "string"
            ? event.result
            : JSON.stringify(event.result ?? "");
        outcome.isError = Boolean(event.is_error);
      }
    });

    child.stderr.on("data", (chunk) => {
      outcome.stderrTail = (outcome.stderrTail + chunk.toString()).slice(
        -STDERR_TAIL_BYTES,
      );
    });

    child.on("error", (error) => {
      outcome.isError = true;
      outcome.stderrTail = outcome.stderrTail || String(error?.message ?? error);
      finish();
    });
    child.on("close", (code, signal) => {
      outcome.exitCode = code;
      outcome.signal = signal ?? null;
      finish();
    });
  });
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npm test`
Expected: PASS（若 `spawn failure` 測試在 spawnImpl=真 spawn 下是以 `error` 事件而非 throw 呈現，兩種路徑程式碼都已涵蓋）

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: claude turn runner — stdin prompt, stream-json capture, timeout escalation, EPIPE survival"
```

---

### Task 8: `worker.mjs` — 任務執行核心（前景與背景共用）

**Files:**
- Create: `plugins/delegate/scripts/lib/worker.mjs`
- Test: `tests/worker.test.mjs`

- [ ] **Step 1: 寫失敗測試 `tests/worker.test.mjs`**

```js
import { makeTempDir, makeDataRoot, writeProfile } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWorker } from "../plugins/delegate/scripts/lib/worker.mjs";
import {
  writeJob,
  readJob,
  promptFilePath,
  logFilePath,
} from "../plugins/delegate/scripts/lib/state.mjs";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fake-claude.mjs",
);

function fakeSpawn(mode) {
  return (_binary, _args, options) =>
    spawn(process.execPath, [FIXTURE], {
      ...options,
      env: { ...options.env, FAKE_CLAUDE_MODE: mode },
    });
}

function seedJob(stateDir, settingsPath, overrides = {}) {
  const job = {
    id: "dlg-w1",
    status: "queued",
    profile: "kimi",
    settingsPath,
    permissionMode: "bypassPermissions",
    cwd: process.cwd(),
    timeoutMs: 5000,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  writeJob(stateDir, job);
  fs.mkdirSync(path.dirname(promptFilePath(stateDir, job.id)), { recursive: true });
  fs.writeFileSync(promptFilePath(stateDir, job.id), "do the thing");
  return job;
}

test("runWorker: success path finalizes completed with result + session id + log", async () => {
  const stateDir = makeTempDir();
  const dataRoot = makeDataRoot();
  const settingsPath = writeProfile(dataRoot, "kimi", {
    env: { ANTHROPIC_BASE_URL: "https://cheap" },
  });
  seedJob(stateDir, settingsPath);
  await runWorker({
    stateDir,
    jobId: "dlg-w1",
    deps: { spawnImpl: fakeSpawn("success") },
  });
  const job = readJob(stateDir, "dlg-w1");
  assert.equal(job.status, "completed");
  assert.equal(job.sessionId, "sess-fake-1");
  assert.match(job.resultText, /^echo:do the thing/);
  assert.ok(fs.existsSync(logFilePath(stateDir, "dlg-w1")), "raw stream logged");
});

test("runWorker: spawned claude gets REBUILT env (no pollution, profile injected, marker set)", async () => {
  const stateDir = makeTempDir();
  const dataRoot = makeDataRoot();
  const settingsPath = writeProfile(dataRoot, "kimi", {
    env: { ANTHROPIC_BASE_URL: "https://cheap" },
  });
  seedJob(stateDir, settingsPath);
  let seenEnv = null;
  const spy = (_b, _a, options) => {
    seenEnv = options.env;
    return spawn(process.execPath, [FIXTURE], {
      ...options,
      env: { ...options.env, FAKE_CLAUDE_MODE: "success" },
    });
  };
  await runWorker({
    stateDir,
    jobId: "dlg-w1",
    deps: {
      spawnImpl: spy,
      baseEnv: {
        PATH: process.env.PATH,
        ANTHROPIC_BASE_URL: "https://expensive",
        ANTHROPIC_MODEL: "opus",
        CLAUDECODE: "1",
      },
    },
  });
  assert.equal(seenEnv.ANTHROPIC_BASE_URL, "https://cheap");
  assert.ok(!("ANTHROPIC_MODEL" in seenEnv));
  assert.ok(!("CLAUDECODE" in seenEnv));
  assert.equal(seenEnv.CLAUDE_DELEGATE_ACTIVE, "1");
});

test("runWorker: failure path finalizes failed with stderr tail", async () => {
  const stateDir = makeTempDir();
  const dataRoot = makeDataRoot();
  const settingsPath = writeProfile(dataRoot, "kimi", { env: {} });
  seedJob(stateDir, settingsPath);
  await runWorker({
    stateDir,
    jobId: "dlg-w1",
    deps: { spawnImpl: fakeSpawn("fail") },
  });
  const job = readJob(stateDir, "dlg-w1");
  assert.equal(job.status, "failed");
  assert.match(job.error, /invalid auth token/);
});

test("runWorker: timeout finalizes timed-out", async () => {
  const stateDir = makeTempDir();
  const dataRoot = makeDataRoot();
  const settingsPath = writeProfile(dataRoot, "kimi", { env: {} });
  seedJob(stateDir, settingsPath, { timeoutMs: 300 });
  await runWorker({
    stateDir,
    jobId: "dlg-w1",
    deps: { spawnImpl: fakeSpawn("hang"), graceMs: 200 },
  });
  assert.equal(readJob(stateDir, "dlg-w1").status, "timed-out");
});

test("runWorker: missing job file exits 1 without throwing", async () => {
  const stateDir = makeTempDir();
  assert.equal(await runWorker({ stateDir, jobId: "ghost" }), 1);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test`
Expected: FAIL（worker.mjs not found）

- [ ] **Step 3: 寫 `plugins/delegate/scripts/lib/worker.mjs`**

```js
// Shared turn executor: the foreground path awaits it in-process; the
// background path runs it as a detached `node worker.mjs <stateDir> <jobId>`.
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildDelegateEnv } from "./env.mjs";
import { resolveProfile } from "./profiles.mjs";
import { buildClaudeArgs, runClaudeTurn } from "./claude.mjs";
import {
  readJob,
  writeJob,
  finalizeJob,
  promptFilePath,
  logFilePath,
} from "./state.mjs";

export async function runWorker({ stateDir, jobId, deps = {} }) {
  const job = readJob(stateDir, jobId);
  if (!job) return 1;
  let prompt;
  try {
    prompt = fs.readFileSync(promptFilePath(stateDir, jobId), "utf8");
  } catch {
    finalizeJob(stateDir, jobId, { status: "failed", error: "prompt file missing" });
    return 1;
  }

  let profile;
  try {
    profile = resolveProfile({ settingsPath: job.settingsPath });
  } catch (error) {
    finalizeJob(stateDir, jobId, { status: "failed", error: String(error.message) });
    return 1;
  }

  writeJob(stateDir, { ...job, status: "running", pid: deps.pid ?? process.pid });

  const env = buildDelegateEnv({
    baseEnv: deps.baseEnv ?? process.env,
    profileEnv: profile.env,
  });
  const logStream = fs.createWriteStream(logFilePath(stateDir, jobId), { flags: "a" });
  const outcome = await runClaudeTurn({
    binary: deps.binary ?? process.env.DELEGATE_CLAUDE_BIN ?? "claude",
    args: buildClaudeArgs({
      settingsPath: job.settingsPath,
      permissionMode: job.permissionMode,
      resumeSessionId: job.resumeSessionId,
    }),
    prompt,
    env,
    cwd: job.cwd,
    timeoutMs: job.timeoutMs,
    graceMs: deps.graceMs,
    spawnImpl: deps.spawnImpl,
    onLine: (line) => logStream.write(line + "\n"),
  });
  logStream.end();

  const failed =
    outcome.isError || outcome.stdinError || outcome.exitCode !== 0;
  const status = outcome.timedOut ? "timed-out" : failed ? "failed" : "completed";
  const error = outcome.stdinError
    ? `stdin: ${outcome.stdinError.code ?? outcome.stdinError.message}`
    : failed && !outcome.timedOut
      ? (outcome.stderrTail || "claude exited nonzero").slice(-500)
      : null;
  finalizeJob(stateDir, jobId, {
    status,
    exitCode: outcome.exitCode,
    sessionId: outcome.sessionId ?? job.sessionId ?? null,
    resultText: outcome.resultText,
    error,
  });
  return 0;
}

const isCliEntry =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const [stateDir, jobId] = process.argv.slice(2);
  runWorker({ stateDir, jobId }).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: worker — shared turn executor with env rebuild, log capture, terminal finalize"
```

---

### Task 9: `render.mjs` — status/result 輸出

**Files:**
- Create: `plugins/delegate/scripts/lib/render.mjs`
- Test: `tests/render.test.mjs`

- [ ] **Step 1: 寫失敗測試 `tests/render.test.mjs`**

```js
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  renderStatus,
  renderResult,
} from "../plugins/delegate/scripts/lib/render.mjs";

test("renderStatus: empty and populated", () => {
  assert.match(renderStatus([]), /No delegate jobs/);
  const text = renderStatus([
    {
      id: "dlg-1",
      status: "running",
      profile: "kimi",
      promptPreview: "fix the bug",
      createdAt: "2026-06-11T00:00:00Z",
    },
  ]);
  assert.match(text, /dlg-1/);
  assert.match(text, /running/);
  assert.match(text, /kimi/);
});

test("renderResult: completed shows result text; failed shows error + log tail", () => {
  const ok = renderResult(
    { id: "dlg-1", status: "completed", profile: "kimi", resultText: "all done" },
    "",
  );
  assert.match(ok, /all done/);
  const bad = renderResult(
    { id: "dlg-2", status: "failed", profile: "glm", error: "auth", sessionId: "s1" },
    "line1\nline2",
  );
  assert.match(bad, /failed/);
  assert.match(bad, /auth/);
  assert.match(bad, /line2/);
  assert.match(bad, /--resume-id/, "failed jobs advertise resume");
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test`
Expected: FAIL（module not found）

- [ ] **Step 3: 寫 `plugins/delegate/scripts/lib/render.mjs`**

```js
export function renderStatus(jobs) {
  if (!jobs.length) return "No delegate jobs in this workspace.";
  return jobs
    .map((job) =>
      [
        job.id,
        (job.status ?? "?").padEnd(9),
        `profile=${job.profile ?? "?"}`,
        job.createdAt ?? "",
        job.promptPreview ? `“${job.promptPreview}”` : "",
      ]
        .filter(Boolean)
        .join("  "),
    )
    .join("\n");
}

export function renderResult(job, logTail = "") {
  const head = `[${job.id}] ${job.status} (profile=${job.profile ?? "?"})`;
  if (job.status === "completed") {
    return `${head}\n\n${job.resultText ?? "(no result text)"}`;
  }
  const lines = [head];
  if (job.error) lines.push(`error: ${job.error}`);
  if (logTail) lines.push("", "--- log tail ---", logTail);
  if (job.sessionId) {
    lines.push(
      "",
      `Tip: continue this thread with: task --resume-id ${job.id} "<follow-up>"`,
    );
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: render — status table and result view with resume hint"
```

---

### Task 10: companion CLI — `task` 與 `execute-plan`（前景 + 背景 + resume）

**Files:**
- Create: `plugins/delegate/scripts/delegate-companion.mjs`
- Test: `tests/companion-task.test.mjs`

- [ ] **Step 1: 寫失敗測試 `tests/companion-task.test.mjs`**

```js
import { makeDataRoot, makeTempDir, writeProfile } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCompanion } from "../plugins/delegate/scripts/delegate-companion.mjs";
import {
  workspaceStateDir,
  listJobs,
  readJob,
  promptFilePath,
} from "../plugins/delegate/scripts/lib/state.mjs";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fake-claude.mjs",
);
const fakeSpawn =
  (mode) =>
  (_b, _a, options) =>
    spawn(process.execPath, [FIXTURE], {
      ...options,
      env: { ...options.env, FAKE_CLAUDE_MODE: mode },
    });

function setup() {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("delegate-ws-");
  writeProfile(dataRoot, "kimi", { env: { ANTHROPIC_BASE_URL: "https://cheap" } });
  const out = [];
  const deps = {
    env: { DELEGATE_PLUGIN_DATA: dataRoot, PATH: process.env.PATH },
    cwd,
    out: (line) => out.push(line),
    claudeSpawnImpl: fakeSpawn("success"),
  };
  return { dataRoot, cwd, out, deps, stateDir: workspaceStateDir(dataRoot, cwd) };
}

test("recursion guard: CLAUDE_DELEGATE_ACTIVE=1 makes companion a no-op", async () => {
  const { deps, out } = setup();
  deps.env.CLAUDE_DELEGATE_ACTIVE = "1";
  const code = await runCompanion(["task", "anything"], deps);
  assert.equal(code, 0);
  assert.match(out.join("\n"), /recursion guard/);
});

test("foreground task: runs to completion and prints the result", async () => {
  const { deps, out, stateDir } = setup();
  const code = await runCompanion(
    ["task", "say", "hi", "--profile", "kimi"],
    deps,
  );
  assert.equal(code, 0);
  const jobs = listJobs(stateDir);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "completed");
  assert.equal(jobs[0].profile, "kimi");
  assert.match(out.join("\n"), /echo:say hi/);
  assert.equal(
    fs.readFileSync(promptFilePath(stateDir, jobs[0].id), "utf8"),
    "say hi",
  );
});

test("background task: writes queued job + prompt file and spawns detached worker", async () => {
  const { deps, out, stateDir } = setup();
  const spawned = [];
  deps.workerSpawnImpl = (cmd, args, options) => {
    spawned.push({ cmd, args, options });
    return { unref() {}, pid: 7777 };
  };
  const code = await runCompanion(
    ["task", "long", "job", "--profile", "kimi", "--background"],
    deps,
  );
  assert.equal(code, 0);
  const jobs = listJobs(stateDir);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "queued");
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args.some((a) => a.includes("worker.mjs")));
  assert.ok(spawned[0].args.includes(jobs[0].id));
  assert.equal(spawned[0].options.detached, true);
  assert.match(out.join("\n"), new RegExp(jobs[0].id));
});

test("task without profile or default fails with guidance, creates no job", async () => {
  const { deps, out, stateDir } = setup();
  const code = await runCompanion(["task", "hi"], deps);
  assert.notEqual(code, 0);
  assert.equal(listJobs(stateDir).length, 0);
  assert.match(out.join("\n"), /profile/i);
});

test("resume-id reuses source job settings + session, links resumedFrom", async () => {
  const { deps, stateDir } = setup();
  await runCompanion(["task", "first", "--profile", "kimi"], deps);
  const first = listJobs(stateDir)[0];
  assert.equal(first.sessionId, "sess-fake-1");
  const code = await runCompanion(
    ["task", "follow", "up", "--resume-id", first.id],
    deps,
  );
  assert.equal(code, 0);
  const jobs = listJobs(stateDir);
  const resumed = jobs.find((j) => j.id !== first.id);
  assert.equal(resumed.resumedFrom, first.id);
  assert.equal(resumed.resumeSessionId, "sess-fake-1");
  assert.equal(resumed.settingsPath, first.settingsPath);
});

test("resume-last picks newest terminal job with a session id", async () => {
  const { deps, stateDir } = setup();
  await runCompanion(["task", "first", "--profile", "kimi"], deps);
  const code = await runCompanion(["task", "more", "--resume-last"], deps);
  assert.equal(code, 0);
  assert.equal(listJobs(stateDir).length, 2);
});

test("execute-plan wraps the plan file into the prompt", async () => {
  const { deps, cwd, stateDir } = setup();
  const planPath = path.join(cwd, "plan.md");
  fs.writeFileSync(planPath, "# The Plan\n1. do X");
  const code = await runCompanion(
    ["execute-plan", planPath, "--profile", "kimi"],
    deps,
  );
  assert.equal(code, 0);
  const job = listJobs(stateDir)[0];
  const prompt = fs.readFileSync(promptFilePath(stateDir, job.id), "utf8");
  assert.match(prompt, /pre-approved implementation plan/);
  assert.match(prompt, /# The Plan/);
});

test("execute-plan with missing file fails cleanly", async () => {
  const { deps, out } = setup();
  const code = await runCompanion(
    ["execute-plan", "/no/such/plan.md", "--profile", "kimi"],
    deps,
  );
  assert.notEqual(code, 0);
  assert.match(out.join("\n"), /plan file/i);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test`
Expected: FAIL（delegate-companion.mjs not found）

- [ ] **Step 3: 寫 `plugins/delegate/scripts/delegate-companion.mjs`**

```js
#!/usr/bin/env node
// CLI entry. Commands: setup | task | execute-plan | status | result | cancel
// Testable via runCompanion(argv, deps) with injectable seams.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError } from "./lib/args.mjs";
import { resolveProfile, listProfiles, ProfileError } from "./lib/profiles.mjs";
import { resolveTimeoutMs } from "./lib/claude.mjs";
import { runWorker } from "./lib/worker.mjs";
import { renderStatus, renderResult } from "./lib/render.mjs";
import { reconcileDeadPids, cancelJob } from "./lib/job-control.mjs";
import {
  resolveDataRoot,
  workspaceStateDir,
  newJobId,
  writeJob,
  readJob,
  listJobs,
  pruneJobs,
  promptFilePath,
  logFilePath,
  TERMINAL_STATUSES,
} from "./lib/state.mjs";

const USAGE = `usage: delegate-companion <command> [...]
  setup
  task <prompt...> [--profile <name>|--settings <path>] [--background] [--resume-id <job>|--resume-last] [--timeout-ms <n>]
  execute-plan <plan-file> [same flags as task]
  status
  result [<job-id>|--last]
  cancel <job-id>`;

const TASK_FLAGS = {
  valueFlags: ["profile", "settings", "resume-id", "timeout-ms"],
  boolFlags: ["background", "resume-last"],
};

const EXECUTE_PLAN_TEMPLATE = (plan) => `You are executing a pre-approved implementation plan. Read it carefully, then implement it COMPLETELY:
- Follow the plan's tasks in order; run every verification step it specifies.
- Do not redesign or skip steps. If a step is impossible, finish what you can and report the blocker in your final summary.
- Commit as the plan instructs.

<plan>
${plan}
</plan>`;

export async function runCompanion(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((line) => process.stdout.write(line + "\n"));
  if (env.CLAUDE_DELEGATE_ACTIVE === "1") {
    out("delegate: disabled inside a delegate session (recursion guard).");
    return 0;
  }
  const cwd = deps.cwd ?? process.cwd();
  const dataRoot = resolveDataRoot(env);
  const stateDir = workspaceStateDir(dataRoot, cwd);
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "setup":
        return cmdSetup({ env, out, dataRoot, deps });
      case "task":
        return await cmdTask({ argv: rest, env, out, cwd, dataRoot, stateDir, deps });
      case "execute-plan":
        return await cmdExecutePlan({ argv: rest, env, out, cwd, dataRoot, stateDir, deps });
      case "status":
        return cmdStatus({ out, stateDir });
      case "result":
        return cmdResult({ argv: rest, out, stateDir });
      case "cancel":
        return cmdCancel({ argv: rest, out, stateDir });
      default:
        out(USAGE);
        return command ? 1 : 0;
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof ProfileError) {
      out(`delegate: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function cmdSetup({ env, out, dataRoot, deps }) {
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
  const binary = env.DELEGATE_CLAUDE_BIN ?? "claude";
  const probe = spawnSyncImpl(binary, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    out(`✗ claude CLI not runnable (${binary}). Install Claude Code first.`);
  } else {
    out(`✓ claude CLI: ${String(probe.stdout).trim()}`);
  }
  const names = listProfiles(dataRoot);
  if (!names.length) {
    out(`✗ no profiles. Create <name>.json under ${path.join(dataRoot, "profiles")} (standard Claude Code settings format, env block carries ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN).`);
  }
  for (const name of names) {
    try {
      resolveProfile({ dataRoot, profile: name, env: {} });
      out(`✓ profile ${name}`);
    } catch (error) {
      out(`✗ profile ${name}: ${error.message}`);
    }
  }
  out(
    env.DELEGATE_DEFAULT_PROFILE
      ? `default profile: ${env.DELEGATE_DEFAULT_PROFILE}`
      : "default profile: (none — pass --profile per call or set DELEGATE_DEFAULT_PROFILE)",
  );
  return 0;
}

function resolveResumeSource({ flags, stateDir }) {
  if (flags["resume-id"]) {
    const source = readJob(stateDir, flags["resume-id"]);
    if (!source) throw new UsageError(`No job ${flags["resume-id"]} to resume`);
    if (!source.sessionId)
      throw new UsageError(`Job ${source.id} has no session id to resume`);
    return source;
  }
  if (flags["resume-last"]) {
    const source = listJobs(stateDir).find(
      (j) => TERMINAL_STATUSES.has(j.status) && j.sessionId,
    );
    if (!source) throw new UsageError("No resumable job in this workspace");
    return source;
  }
  return null;
}

async function startJob({ prompt, promptPreview, flags, env, out, cwd, dataRoot, stateDir, deps }) {
  const source = resolveResumeSource({ flags, stateDir });
  let settingsPath;
  let profileName;
  if (source) {
    settingsPath = source.settingsPath;
    profileName = source.profile;
  } else {
    const profile = resolveProfile({
      dataRoot,
      profile: flags.profile,
      settingsPath: flags.settings,
      env,
    });
    settingsPath = profile.path;
    profileName = profile.name;
  }
  const job = {
    id: newJobId(),
    status: "queued",
    profile: profileName,
    settingsPath,
    permissionMode: env.DELEGATE_PERMISSION_MODE ?? "bypassPermissions",
    cwd,
    timeoutMs: flags["timeout-ms"] ? Number(flags["timeout-ms"]) : resolveTimeoutMs(env),
    background: Boolean(flags.background),
    resumedFrom: source?.id ?? null,
    resumeSessionId: source?.sessionId ?? null,
    promptPreview,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(promptFilePath(stateDir, job.id)), { recursive: true });
  fs.writeFileSync(promptFilePath(stateDir, job.id), prompt);
  writeJob(stateDir, job);
  pruneJobs(stateDir);

  if (job.background) {
    const workerPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "lib",
      "worker.mjs",
    );
    const spawnImpl = deps.workerSpawnImpl ?? spawn;
    const child = spawnImpl(
      process.execPath,
      [workerPath, stateDir, job.id],
      { detached: true, stdio: "ignore", env: { ...env } },
    );
    child.unref();
    out(`Started background job ${job.id} (profile=${job.profile}).`);
    out(`Check: status | result ${job.id} | cancel ${job.id}`);
    return 0;
  }

  await runWorker({
    stateDir,
    jobId: job.id,
    deps: {
      spawnImpl: deps.claudeSpawnImpl,
      binary: env.DELEGATE_CLAUDE_BIN,
      baseEnv: env,
    },
  });
  const finished = readJob(stateDir, job.id);
  out(renderResult(finished, readLogTail(stateDir, job.id)));
  return finished.status === "completed" ? 0 : 1;
}

async function cmdTask({ argv, env, out, cwd, dataRoot, stateDir, deps }) {
  const { flags, positionals } = parseArgs(argv, TASK_FLAGS);
  const prompt = positionals.join(" ").trim();
  if (!prompt) throw new UsageError("task requires a prompt");
  return startJob({
    prompt,
    promptPreview: prompt.slice(0, 120),
    flags, env, out, cwd, dataRoot, stateDir, deps,
  });
}

async function cmdExecutePlan({ argv, env, out, cwd, dataRoot, stateDir, deps }) {
  const { flags, positionals } = parseArgs(argv, TASK_FLAGS);
  const planPath = positionals[0];
  if (!planPath) throw new UsageError("execute-plan requires a plan file path");
  let plan;
  try {
    plan = fs.readFileSync(path.resolve(cwd, planPath), "utf8");
  } catch {
    throw new UsageError(`plan file not readable: ${planPath}`);
  }
  return startJob({
    prompt: EXECUTE_PLAN_TEMPLATE(plan),
    promptPreview: `execute-plan ${path.basename(planPath)}`,
    flags, env, out, cwd, dataRoot, stateDir, deps,
  });
}

function readLogTail(stateDir, jobId, lines = 30) {
  try {
    const text = fs.readFileSync(logFilePath(stateDir, jobId), "utf8");
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function cmdStatus({ out, stateDir }) {
  reconcileDeadPids(stateDir);
  out(renderStatus(listJobs(stateDir)));
  return 0;
}

function cmdResult({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, { boolFlags: ["last"] });
  reconcileDeadPids(stateDir);
  const job = flags.last
    ? listJobs(stateDir)[0]
    : positionals[0]
      ? readJob(stateDir, positionals[0])
      : listJobs(stateDir)[0];
  if (!job) {
    out("No delegate jobs in this workspace.");
    return 1;
  }
  out(renderResult(job, job.status === "completed" ? "" : readLogTail(stateDir, job.id)));
  return job.status === "completed" ? 0 : 1;
}

function cmdCancel({ argv, out, stateDir }) {
  const { positionals } = parseArgs(argv, {});
  if (!positionals[0]) throw new UsageError("cancel requires a job id");
  const result = cancelJob(stateDir, positionals[0]);
  out(result.message);
  return result.ok ? 0 : 1;
}

const isCliEntry =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  runCompanion(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`delegate: ${error?.stack ?? error}\n`);
      process.exit(1);
    },
  );
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test`
Expected: PASS（全部既有測試 + 本任務 8 個）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: companion CLI — task/execute-plan with background, resume, recursion guard"
```

---

### Task 11: companion 其餘指令的測試補強（status/result/cancel/setup）

**Files:**
- Test: `tests/companion-control.test.mjs`

（實作已在 Task 10 寫完 — 本任務純粹補上控制面指令的行為測試。）

- [ ] **Step 1: 寫測試 `tests/companion-control.test.mjs`**

```js
import { makeDataRoot, makeTempDir, writeProfile } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCompanion } from "../plugins/delegate/scripts/delegate-companion.mjs";
import {
  workspaceStateDir,
  writeJob,
  readJob,
} from "../plugins/delegate/scripts/lib/state.mjs";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fake-claude.mjs",
);

function setup() {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("delegate-ws-");
  writeProfile(dataRoot, "kimi", { env: {} });
  const out = [];
  const deps = {
    env: { DELEGATE_PLUGIN_DATA: dataRoot, PATH: process.env.PATH },
    cwd,
    out: (line) => out.push(line),
    claudeSpawnImpl: (_b, _a, options) =>
      spawn(process.execPath, [FIXTURE], {
        ...options,
        env: { ...options.env, FAKE_CLAUDE_MODE: "success" },
      }),
  };
  return { out, deps, stateDir: workspaceStateDir(dataRoot, cwd) };
}

test("status reconciles dead pids before rendering", async () => {
  const { out, deps, stateDir } = setup();
  writeJob(stateDir, { id: "dlg-z", status: "running", pid: 999999, createdAt: "a" });
  const code = await runCompanion(["status"], deps);
  assert.equal(code, 0);
  assert.equal(readJob(stateDir, "dlg-z").status, "failed");
  assert.match(out.join("\n"), /dlg-z/);
});

test("result --last returns newest job; result with no jobs exits 1", async () => {
  const { out, deps } = setup();
  assert.equal(await runCompanion(["result", "--last"], deps), 1);
  await runCompanion(["task", "hi", "--profile", "kimi"], deps);
  out.length = 0;
  assert.equal(await runCompanion(["result", "--last"], deps), 0);
  assert.match(out.join("\n"), /echo:hi/);
});

test("cancel running job then result shows cancelled", async () => {
  const { out, deps, stateDir } = setup();
  writeJob(stateDir, { id: "dlg-r", status: "running", pid: process.pid, createdAt: "a" });
  // process.pid 是活的 — 但 killImpl 不可注入到 companion 層，因此這裡只驗證
  // 狀態機：cancel 後 job 為 cancelled。對自己送 SIGTERM 是危險的，所以先把
  // pid 改成不存在的，讓 cancelJob 走「不發信號」分支。
  writeJob(stateDir, { ...readJob(stateDir, "dlg-r"), pid: 999998 });
  const code = await runCompanion(["cancel", "dlg-r"], deps);
  assert.equal(code, 0);
  assert.equal(readJob(stateDir, "dlg-r").status, "cancelled");
  assert.match(out.join("\n"), /Cancelled/);
});

test("setup reports claude binary and profile validity", async () => {
  const { out, deps } = setup();
  deps.spawnSyncImpl = () => ({ status: 0, stdout: "9.9.9 (fake)\n" });
  const code = await runCompanion(["setup"], deps);
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /9\.9\.9/);
  assert.match(text, /✓ profile kimi/);
  assert.match(text, /default profile/);
});

test("unknown command prints usage and exits 1", async () => {
  const { out, deps } = setup();
  const code = await runCompanion(["bogus"], deps);
  assert.equal(code, 1);
  assert.match(out.join("\n"), /usage:/);
});
```

- [ ] **Step 2: 跑測試**

Run: `npm test`
Expected: PASS（若 `cancel` 測試發現 cancelJob 對不存在 pid 走錯分支，回 Task 6 檢查 isAlive 判斷）

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test: companion control-plane coverage (status/result/cancel/setup)"
```

---

### Task 12: slash commands、README、結構測試、最終驗證

**Files:**
- Create: `plugins/delegate/commands/task.md`
- Create: `plugins/delegate/commands/execute-plan.md`
- Create: `plugins/delegate/commands/status.md`
- Create: `plugins/delegate/commands/result.md`
- Create: `plugins/delegate/commands/cancel.md`
- Create: `plugins/delegate/commands/setup.md`
- Create: `README.md`
- Test: `tests/plugin-structure.test.mjs`

- [ ] **Step 1: 寫失敗測試 `tests/plugin-structure.test.mjs`**

```js
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMANDS = ["task", "execute-plan", "status", "result", "cancel", "setup"];

test("every command md exists, has frontmatter, forwards to the companion", () => {
  for (const name of COMMANDS) {
    const file = path.join(ROOT, "plugins/delegate/commands", `${name}.md`);
    assert.ok(fs.existsSync(file), `${name}.md missing`);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.startsWith("---"), `${name}.md missing frontmatter`);
    assert.match(text, /description:/);
    assert.match(text, /delegate-companion\.mjs/);
  }
});

test("manifests agree on plugin name and version", () => {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".claude-plugin/marketplace.json"), "utf8"),
  );
  const plugin = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "plugins/delegate/.claude-plugin/plugin.json"),
      "utf8",
    ),
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(plugin.name, "delegate");
  assert.equal(marketplace.plugins[0].name, "delegate");
  assert.equal(plugin.version, pkg.version);
  assert.equal(marketplace.plugins[0].version, pkg.version);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test`
Expected: FAIL（commands 不存在）

- [ ] **Step 3: 寫六個 command md（先 `ls /home/audichuang/research/codex-plugin-cc/plugins/codex/commands/` 並讀其中一兩個，沿用同樣的轉發寫法；以下為內容基準）**

`plugins/delegate/commands/task.md`：

```markdown
---
description: Delegate an execution task to a cheap-model headless Claude Code instance
argument-hint: "<prompt> [--profile <name>] [--background] [--resume-last|--resume-id <job>]"
---

Run the delegate companion with the user's arguments and relay its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" task $ARGUMENTS
```

- For long tasks add `--background`, then poll with /delegate:status.
- The prompt must be a complete, self-contained instruction — the delegate
  is a cheap model: spell out files, constraints, and the definition of done.
- Report the companion's output back to the user verbatim.
```

`plugins/delegate/commands/execute-plan.md`：

```markdown
---
description: Hand a plan file to a cheap-model headless Claude Code for full implementation
argument-hint: "<plan-file> [--profile <name>] [--background]"
---

Run the delegate companion and relay its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" execute-plan $ARGUMENTS
```

Plans are executed literally — make sure the plan file is complete before delegating.
```

`plugins/delegate/commands/status.md`：

```markdown
---
description: List delegate jobs in this workspace
---

Run and relay:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" status
```
```

`plugins/delegate/commands/result.md`：

```markdown
---
description: Fetch the result of a delegate job
argument-hint: "[<job-id>|--last]"
---

Run and relay:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" result $ARGUMENTS
```
```

`plugins/delegate/commands/cancel.md`：

```markdown
---
description: Cancel a running delegate job
argument-hint: "<job-id>"
---

Run and relay:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" cancel $ARGUMENTS
```
```

`plugins/delegate/commands/setup.md`：

```markdown
---
description: Check the claude CLI and validate delegate profiles
---

Run and relay:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" setup
```

If no profiles exist, walk the user through creating one (standard Claude Code
settings JSON with an env block: ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, model).
```

- [ ] **Step 4: 寫 `README.md`**

```markdown
# delegate-plugin-cc

Delegate execution tasks from Claude Code to **cheap-model headless Claude Code
instances**. The main session (your strong model) thinks and plans; `/delegate:task`
and `/delegate:execute-plan` hand the work to a profile-selected cheap model that
still inherits your whole ecosystem — CLAUDE.md, skills, subagents, MCP servers —
because the delegate IS Claude Code, spawned in the same project directory.

## Profiles

A profile is a standard Claude Code settings.json at
`<plugin-data>/profiles/<name>.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.moonshot.example/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-...."
  },
  "model": "kimi-k2"
}
```

Select with `--profile kimi`, or set `DELEGATE_DEFAULT_PROFILE=kimi`.

## Isolation

The delegate env is rebuilt, never inherited: all `ANTHROPIC_*` / `CLAUDE_*` /
`CLAUDECODE*` vars from the main session are stripped, the profile env block is
injected, and `CLAUDE_DELEGATE_ACTIVE=1` disables this plugin inside the
delegate (recursion guard). `HOME` stays shared on purpose — that's where your
user-level skills/agents live.

## Commands

/delegate:setup · /delegate:task · /delegate:execute-plan · /delegate:status ·
/delegate:result · /delegate:cancel

## Env knobs

- `DELEGATE_DEFAULT_PROFILE` — profile used when --profile is omitted
- `DELEGATE_PERMISSION_MODE` — default bypassPermissions
- `DELEGATE_JOB_TIMEOUT_MS` — default 3600000 (1h)
- `DELEGATE_CLAUDE_BIN` — claude binary override (tests/smoke)
```

- [ ] **Step 5: 跑全部測試**

Run: `npm test`
Expected: PASS（全 suite 綠）

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: slash commands, README, plugin structure tests"
```

- [ ] **Step 7: 手動 smoke（不進 CI；需要真實 claude CLI 與一個真 profile）**

```bash
cd /home/audichuang/research/delegate-plugin-cc
mkdir -p /tmp/delegate-smoke/profiles
cat > /tmp/delegate-smoke/profiles/real.json <<'EOF'
{ "env": {} }
EOF
DELEGATE_PLUGIN_DATA=/tmp/delegate-smoke \
  node plugins/delegate/scripts/delegate-companion.mjs setup
DELEGATE_PLUGIN_DATA=/tmp/delegate-smoke \
  node plugins/delegate/scripts/delegate-companion.mjs task "reply with the single word PONG" --profile real
```

Expected: setup 列出 `✓ profile real`；task 回傳含 `PONG` 的 result（空 env profile = 用本機既有 claude 登入，僅驗證管線；之後換成真便宜端點的 profile 再驗一次模型路由）。

---

## Self-Review 紀錄

- **Spec coverage**：§4 profiles（Task 4）、§5 spawn/stream/state/resume（Task 5/7/8/10）、§7 env 重建（Task 3 + Task 8 spy 測試）、§8 防遞迴（Task 10 guard + 測試）、§9 權限（Task 7/10 預設 + `DELEGATE_PERMISSION_MODE`）、§10 錯誤處理（Task 4 fail-fast、Task 7 EPIPE/timeout/ENOENT、Task 10 plan 缺檔）、§11 測試策略（hermetic helpers + fake-claude 全模式）、§13 命名（Task 1/12）。`state.json` 索引為已核准省略（見計畫開頭）。
- **Placeholder scan**：無 TBD；所有測試與實作皆附完整程式碼。manifests 與 commands 的格式以 codex-plugin-cc 現檔為基準核對（Task 1 Step 4、Task 12 Step 3 已內建核對指示）。
- **Type consistency**：`runCompanion(argv, deps)`、`runWorker({stateDir, jobId, deps})`、`finalizeJob(stateDir, jobId, patch)`、`resolveProfile({dataRoot, profile, settingsPath, env})` 等簽名跨任務一致；deps seam 名稱統一（`spawnImpl`/`claudeSpawnImpl`/`workerSpawnImpl`/`spawnSyncImpl`/`baseEnv`）。

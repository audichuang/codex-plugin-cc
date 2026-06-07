---
name: testing-with-seams
description: Use when writing or fixing a Node test in this repo (codex-plugin-cc) that touches background jobs, the app-server/broker, child processes, signals, timers, the filesystem, or environment variables — to keep it hermetic and deterministic instead of spawning real processes, reading the real ~/.claude, or flaking on wall-clock.
---

# Testing with seams

## Overview

Tests here run with `node --test tests/*.test.mjs`. A test must **never** touch the
developer's machine: no real child processes signalled, no writes to the real
`~/.claude`/plugin-data, no dependence on ambient env, no wall-clock races, no
network. Two mechanisms make that possible — use them; do not reinvent them.

1. **`import "./helpers.mjs"`** — one line that isolates the whole test file.
2. **Injectable seams** — every runtime lib takes `options`/`deps` that replace the
   real side effect (spawn, kill, RPC, timers) with a recorder.

If a test is hard to write without real IO, the seam already exists — find it
before reaching for a real process or timer.

## Hermetic isolation: always import helpers

```js
import "./helpers.mjs"; // side-effect import — MUST be before importing code under test
import { makeTempDir } from "./helpers.mjs"; // per-test workspace under the temp sandbox
```

`helpers.mjs` (at import time) redirects `CLAUDE_PLUGIN_DATA`, **`HOME` and
`USERPROFILE`** to throwaway temp dirs and drops every ambient `CODEX_*`. That HOME
redirect is load-bearing: `state.mjs`'s `collectCandidateStateRoots` walks
`~/.claude/plugins/data` via `os.homedir()`, so without it cross-workspace lookups
read the developer's real home.

**Do not hand-roll `mkdtempSync` + `CODEX_*` scrubbing inline.** It diverges from
every other test file and reliably forgets HOME. Import the helper.

Use `makeTempDir()` as a job's `workspaceRoot`/`cwd`: a temp dir is not a git repo,
so `resolveWorkspaceRoot` returns it verbatim and the whole job tree stays sandboxed.

## Seam catalog

| Real side effect | Seam (option) | Where |
|---|---|---|
| Kill a process tree | `terminateProcessTree(pid, { killImpl, psImpl, runCommandImpl, platform })` | `lib/process.mjs` |
| Run a command (`ps`/`git`/`taskkill`) | `{ spawnImpl }` / `{ runCommandImpl }` | `lib/process.mjs` |
| Drive a turn without a real app-server | fake `client` (`{ notificationHandler, exitPromise, setNotificationHandler }`) passed to `captureTurn` | `lib/codex.mjs` |
| Idle / completion timers | `captureTurn(..., { timers: { setTimeout, clearTimeout }, idleTimeoutMs })` | `lib/codex.mjs` |
| Interrupt + terminate a tracked job | `runTrackedJob(job, runner, { interruptOnTimeout, terminateOnTimeout, timeoutMs })` | `lib/tracked-jobs.mjs` |
| SessionEnd broker shutdown/teardown | `handleSessionEnd(input, { sendBrokerShutdown, teardownBrokerSession, hasActiveBackgroundJobs, cleanupSessionJobs })` | `session-lifecycle-hook.mjs` |
| Reap/escalate a broker | `reapStaleBroker(session, { killProcess, isProcessAlive, forceKill, sleep, escalateAfterMs })` | `lib/broker-lifecycle.mjs` |
| Spawn worker/watchdog | `enqueueBackgroundTask(ws, job, opts, { spawnWorker, spawnWatchdog })` | `codex-companion.mjs` |

**Fake pids:** alive = `process.pid`; never-allocated/dead = `2_147_483_646`.
`hasActiveBackgroundJobs` treats a background job with a live worker pid as active and
reconciles a dead-pid one to inactive — use these two pids to drive both branches.

## Determinism

- **Force the timeout branch** without wall-clock: a runner that never settles
  (`() => new Promise(() => {})`) so only the injected timeout can resolve the race.
- **Injected timers** with a manual `fireLast()` decide exactly when "idle" elapses.
- **Unref'd scheduled work** (e.g. the post-failure `setTimeout(…,0).unref()` terminate)
  fires on a later macrotask — `await new Promise(r => setTimeout(r, 20))` before
  asserting. Don't use `setImmediate`: it can fire *before* a pending `setTimeout(0)`
  callback, so the assertion runs too early and misses the scheduled work.

## Common mistakes

| Mistake | Why it bites | Fix |
|---|---|---|
| Reinventing isolation inline | Forgets HOME → reads real `~/.claude`; diverges from suite | `import "./helpers.mjs"` |
| `terminateProcessTree(realPid)` with default `killImpl` | The recorded pid is the test runner's own `process.pid` — the test SIGTERMs itself | inject `killImpl`/`terminateOnTimeout` recorder |
| Real `setTimeout(timeoutMs)` raced against a real runner | Flaky pass/fail on a loaded machine | never-settling runner + injected timers |
| Reading `process.env.CODEX_*` set by the dev | Non-deterministic timeouts/session filtering | helpers drops them; pass values explicitly |
| Asserting before unref'd work fired | Misses the scheduled terminate/signal | await a `setImmediate` macrotask |

## Example

```js
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs"; // hermetic env + fs isolation
import { applyJobPatchIfActive, resolveJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

test("runTrackedJob interrupts + terminates on the hard timeout", async () => {
  const workspace = makeTempDir();
  const jobId = "job-x";
  const calls = [];
  const killed = [];

  await assert.rejects(
    runTrackedJob(
      { id: jobId, workspaceRoot: workspace },
      async () => {
        applyJobPatchIfActive(workspace, jobId, { threadId: "th", turnId: "tn" });
        await new Promise(() => {}); // never settles -> only the timeout resolves
      },
      {
        timeoutMs: 40,
        interruptOnTimeout: async (cwd, ctx) => calls.push({ cwd, ctx }),
        terminateOnTimeout: (pid) => killed.push(pid) // recorder, not a real kill
      }
    ),
    /hard timeout/i
  );

  await new Promise((r) => setTimeout(r, 20)); // let the unref'd terminate fire
  assert.deepEqual(calls[0].ctx, { threadId: "th", turnId: "tn" });
  assert.equal(killed[0], process.pid);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8")).status, "failed");
});
```

## Adding a new seam

When new code does real IO (spawn/kill/RPC/timer/network), expose it as an
`options`/`deps` parameter defaulting to the real implementation — same shape as the
catalog above — so it is testable without the side effect. Preserve existing seams
when editing; tests depend on them.

# codex-plugin-cc

A Claude Code plugin (marketplace `openai-codex`, plugin `codex`) that drives the
**real Codex CLI** from inside Claude Code — code review, task delegation, and a
`/codex:handoff` reflect→ask-Codex→bring-back loop. The slash commands and the
`codex:codex-rescue` subagent are thin wrappers; the real logic lives in
`plugins/codex/scripts/`.

## Commands

```bash
npm test                                 # node --test tests/*.test.mjs
node scripts/bump-version.mjs <x.y.z>    # bump every version site in lockstep
node scripts/bump-version.mjs --check    # verify all version sites match
npm run build                            # tsc; prebuild regens app-server types via `codex app-server generate-ts`
```

- **`npm test` is hermetic** — `tests/helpers.mjs` redirects `CLAUDE_PLUGIN_DATA`, `HOME`, and `USERPROFILE` to throwaway temp dirs and drops ambient `CODEX_*` at import, so the suite passes regardless of ambient env and never reads/writes the real `~/.claude/plugins/data/...` (the `HOME` redirect matters: `collectCandidateStateRoots` walks `~/.claude` via `os.homedir()`). Don't reintroduce a dependency on ambient env; keep new tests importing `helpers.mjs`. The `.claude/skills/testing-with-seams` skill is the canonical guide (seam catalog, fake pids, determinism, common mistakes).

## Architecture (`plugins/codex/`)

- `commands/*.md` — slash commands (review, adversarial-review, rescue, execute-plan, handoff, status, result, attach, cancel, setup). Thin; forward to the companion.
- `agents/codex-rescue.md` — rescue subagent (thin forwarder to `task`).
- `skills/` — `codex-cli-runtime`, `codex-result-handling`, `gpt-5-5-prompting` (internal, `user-invocable:false`).
- `scripts/codex-companion.mjs` — CLI entry: setup/review/task/status/result/cancel + background-job orchestration.
- `scripts/lib/`:
  - `app-server.mjs` + `app-server-broker.mjs` + `broker-lifecycle.mjs` — a **per-workspace broker** speaking Codex **app-server v2 JSON-RPC** (`thread/start`, `turn/start`, `turn/interrupt`, `review/start`). One broker per workspace, shared across commands/sessions.
  - `codex.mjs` — builds thread/turn params, captures the streaming turn (`captureTurn`), renders output. `captureTurn` also runs an **opt-in idle watchdog** (`CODEX_TURN_IDLE_TIMEOUT_MS`, default `0` = off) that rejects a silent-but-connected turn so `runTrackedJob` can interrupt + reap it.
  - `state.mjs` + `tracked-jobs.mjs` + `job-control.mjs` — background job state. **Per-job JSON files are the source of truth; `state.json` is a derived index.** Terminal transitions use a cross-process **O_EXCL `.lock` CAS** (first-terminal-writer-wins); file writes are atomic (temp + rename). Pruning never evicts an active (queued/running) job.
  - `codex-watchdog.mjs` + `liveness.mjs` — detached liveness watchdog (escalate-not-kill) for background jobs.
  - `session-lifecycle-hook.mjs` + `stop-review-gate-hook.mjs` — SessionStart/End + stop-gate hooks.
  - helpers: `hook-input.mjs` (EAGAIN-safe shared stdin reader for the hooks), `strings.mjs` (`stripAnsi` + UTF-8-safe `truncateToByteBudget`; app-server stdout parsing strips ANSI and skips non-`{`/`[` lines rather than failing the connection), `idle-shutdown.mjs` (broker idle-exit tracker so an idle broker self-exits).

## Gotchas

- **Bump the version on ANY plugin change**, or the marketplace cache serves the stale copy (it is keyed by version) — new commands silently won't appear. `node scripts/bump-version.mjs <v>` updates package.json, package-lock.json, plugin.json, and marketplace.json (metadata + plugin) together.
- **Default model/effort is `gpt-5.5` / `xhigh`** (override with `--model`/`--effort` or `CODEX_DEFAULT_MODEL`/`CODEX_DEFAULT_EFFORT`). Models are forwarded **verbatim** — no aliasing.
- **Sandbox mode is hardcoded to `danger-full-access`** (`resolveSandboxMode`, `codex.mjs`). Codex normally sandboxes its shell commands with `bwrap`, which creates a network namespace; on hosts that forbid that (`unshare --net` → EPERM, e.g. nested sandboxes/containers) every Codex command aborts before running with `bwrap: loopback: Failed RTM_NEWADDR`. This fork targets such hosts, so the plugin always tells Codex to skip bwrap (isolation comes from the outer environment) and the per-thread requested mode is ignored. `CODEX_SANDBOX_MODE` can still **override** the default — e.g. set `CODEX_SANDBOX_MODE=read-only` on a host where bwrap works. (This is the upstream "do-not-adopt" coercion, applied deliberately for this fork's environment.)
- **The broker is shared per workspace** — never tear it down or kill its pid unconditionally: `broker/shutdown` is busy-gated, SessionEnd skips teardown when the broker is busy, the watchdog only reaps a confirmed hung+unreachable broker, and `reapStaleBroker` verifies process identity before SIGKILL.
- **`--background` jobs outlive their session.** SessionEnd (`cleanupSessionJobs`) skips terminating/pruning jobs tagged `background:true` and keeps the broker alive while any background job is active — and the active-job check must run **before** `sendBrokerShutdown` (the self-shutdown RPC), not only before the local teardown. Foreground/interactive session jobs are still reaped. Before killing a session job, CAS the terminal transition and consult the per-job file (source of truth) so a stale-index reused pid is never signalled.
- **TDD is the workflow**: tests first (`tests/*.test.mjs`). Runtime libs expose injectable seams (deps/options/spawnImpl/clientFactory) for deterministic tests — preserve them when editing.
- **Cross-process safety lives in `state.mjs`**: the job system is multi-process (worker, watchdog, cancel, session hook, reconcile). Any new terminal write must go through `applyJobPatchIfActive` / `claimTerminalTransition`, not a raw `writeJobFile`.
- **Known limitation (Windows):** an npm-installed `codex.cmd` shim can't be spawned with `shell:false`; the cmd.exe-wrapper fix is deferred (see the note in `scripts/lib/process.mjs`).

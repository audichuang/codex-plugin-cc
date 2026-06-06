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

- **`npm test` is hermetic** — `tests/helpers.mjs` redirects `CLAUDE_PLUGIN_DATA` to a throwaway temp dir and drops ambient `CODEX_*` at import, so the suite passes regardless of ambient env and never reads/writes the real `~/.claude/plugins/data/...`. Don't reintroduce a dependency on ambient env; keep new tests importing `helpers.mjs` so they inherit the isolation.

## Architecture (`plugins/codex/`)

- `commands/*.md` — slash commands (review, adversarial-review, rescue, execute-plan, handoff, status, result, cancel, setup). Thin; forward to the companion.
- `agents/codex-rescue.md` — rescue subagent (thin forwarder to `task`).
- `skills/` — `codex-cli-runtime`, `codex-result-handling`, `gpt-5-5-prompting` (internal, `user-invocable:false`).
- `scripts/codex-companion.mjs` — CLI entry: setup/review/task/status/result/cancel + background-job orchestration.
- `scripts/lib/`:
  - `app-server.mjs` + `app-server-broker.mjs` + `broker-lifecycle.mjs` — a **per-workspace broker** speaking Codex **app-server v2 JSON-RPC** (`thread/start`, `turn/start`, `turn/interrupt`, `review/start`). One broker per workspace, shared across commands/sessions.
  - `codex.mjs` — builds thread/turn params, captures the streaming turn, renders output.
  - `state.mjs` + `tracked-jobs.mjs` + `job-control.mjs` — background job state. **Per-job JSON files are the source of truth; `state.json` is a derived index.** Terminal transitions use a cross-process **O_EXCL `.lock` CAS** (first-terminal-writer-wins); file writes are atomic (temp + rename).
  - `codex-watchdog.mjs` + `liveness.mjs` — detached liveness watchdog (escalate-not-kill) for background jobs.
  - `session-lifecycle-hook.mjs` + `stop-review-gate-hook.mjs` — SessionStart/End + stop-gate hooks.

## Gotchas

- **Bump the version on ANY plugin change**, or the marketplace cache serves the stale copy (it is keyed by version) — new commands silently won't appear. `node scripts/bump-version.mjs <v>` updates package.json, package-lock.json, plugin.json, and marketplace.json (metadata + plugin) together.
- **Default model/effort is `gpt-5.5` / `xhigh`** (override with `--model`/`--effort` or `CODEX_DEFAULT_MODEL`/`CODEX_DEFAULT_EFFORT`). Models are forwarded **verbatim** — no aliasing.
- **`CODEX_SANDBOX_MODE`**: Codex sandboxes its shell commands with `bwrap`, which creates a network namespace. On hosts that forbid that (`unshare --net` → EPERM, e.g. nested sandboxes/containers) every Codex command aborts before running with `bwrap: loopback: Failed RTM_NEWADDR`. Set `CODEX_SANDBOX_MODE=danger-full-access` so the plugin tells Codex to skip bwrap (isolation comes from the outer environment).
- **The broker is shared per workspace** — never tear it down or kill its pid unconditionally: `broker/shutdown` is busy-gated, SessionEnd skips teardown when the broker is busy, the watchdog only reaps a confirmed hung+unreachable broker, and `reapStaleBroker` verifies process identity before SIGKILL.
- **TDD is the workflow**: tests first (`tests/*.test.mjs`). Runtime libs expose injectable seams (deps/options/spawnImpl/clientFactory) for deterministic tests — preserve them when editing.
- **Cross-process safety lives in `state.mjs`**: the job system is multi-process (worker, watchdog, cancel, session hook, reconcile). Any new terminal write must go through `applyJobPatchIfActive` / `claimTerminalTransition`, not a raw `writeJobFile`.
- **Known limitation (Windows):** an npm-installed `codex.cmd` shim can't be spawned with `shell:false`; the cmd.exe-wrapper fix is deferred (see the note in `scripts/lib/process.mjs`).

# Changelog

## 1.0.17

Docs/test-clarity polish from the 1.0.16 review. **No behavior change.**

- `session-lifecycle-hook.mjs`: documented the one residual window in the
  cleanupSessionJobs pid guard — if a worker is SIGKILLed before writing a
  terminal status, its per-job file stays "running" with a dead pid, so a
  recycled pid could still be signalled (only the common cleanly-finished case is
  closed; `isProcessAlive` can't catch a recycled-but-live pid).
- Renamed the cleanup test from "CASes before terminating" to "checks the per-job
  source-of-truth before terminating" — the safety comes from the terminal-status
  guard, not CAS ordering (terminate runs before the CAS, which only records the
  failure); the assertions were already correct.

## 1.0.16

Fixes from a Codex deep-review pass (it reproduced each with read-only probes).
TDD; suite 305 green, stable across repeated runs.

- **BLOCKER — `sendBrokerShutdown` settled on a partial socket chunk**
  (`lib/broker-lifecycle.mjs`). The data handler called `done()` after ANY chunk,
  so a busy `-32001` reply fragmented across two reads was misread as
  `busy:false`, letting SessionEnd tear down a still-busy shared broker. Now it
  settles only after a COMPLETE newline-terminated JSON line is parsed (bounded
  by the existing timeout/close). Regression test feeds a split busy reply.
- **BLOCKER — `pruneJobs` could evict an ACTIVE job** (`lib/state.mjs`). The
  index was capped at the newest `MAX_JOBS` by `updatedAt`, so a queued/running
  job with a stale `updatedAt` could be dropped — and `saveState` then deletes
  the evicted job's per-job JSON/log/.done/.lock, destroying the watchdog's view
  of a live/hung background job. Active jobs are now never pruned (kept even
  beyond `MAX_JOBS`); only terminal jobs fill the remaining budget.
- **MAJOR — `cleanupSessionJobs` could SIGTERM a reused pid**
  (`session-lifecycle-hook.mjs`). It terminated the (possibly stale) index pid
  before checking job state. Now it consults the per-job file (source of truth):
  it never signals a job already terminal there, and prefers the per-job pid over
  the index pid. Added a `terminateProcessTree` seam + tests for both branches.
- **MAJOR — adversarial-review prompt cap ignored framing size**
  (`codex-companion.mjs`). The cap only truncated `REVIEW_INPUT`; an oversized
  `focusText`/`USER_FOCUS` could still push the rendered prompt past the API
  limit. Added a final whole-prompt byte backstop. Test drives a ~1.2 MB focus.
- **MINOR — idle watchdog armed before the turn/start ACK** (`lib/codex.mjs`).
  The idle timer now arms only after the ACK (the ACK is separately bounded by
  the per-RPC timeout), and `state.completion` gets an early handler so a
  pre-await idle/transport rejection can never surface as an unhandled rejection.

Deliberately NOT changed: `reapStaleBroker` keeps its asymmetric design
(unconditional graceful SIGTERM, identity-verified SIGKILL escalation) — gating
the SIGTERM on the `/proc`-based identity check would break broker reaping on
hosts without `/proc` (macOS/Windows), a worse regression than the very narrow
pid-reuse window it would close.

## 1.0.15

Post-1.0.14 review polish (all findings were MINOR/NIT — the two 1.0.14 BLOCKER
fixes were independently verified correct, one via a revert-to-red mutation
check). TDD throughout.

- **`captureTurn` no longer fabricates a synthetic `state.error` for a
  malformed, non-terminal `error` notification** (`lib/codex.mjs`). A protocol
  error notification missing its `error` object on a turn that then completes
  normally previously left a phantom "unknown error" that could surface on the
  no-output failure path. We now record `state.error` only for a real error
  object; the terminal-failure branch still installs a fallback reason when it
  actually fails the turn. Locked by an extended `permanent-auth-shortcircuit`
  test asserting `state.error` stays unset.
- **Test robustness:** `strings` "no O(n^2)" test now asserts a coarse
  wall-clock ceiling so a correct-but-quadratic `stripAnsi` refactor is caught
  (the prior output-equality assertion alone would not catch a perf regression);
  a new behavioral `terminate-process-tree` test drives the real
  `readProcessTable` parse path with a multi-thousand-row table and asserts
  every descendant is reaped; `sandbox-mode` test now imports `./helpers.mjs`
  for ambient-env isolation per convention.
- **`testing-with-seams` skill:** fixed a self-contradiction (the Common
  Mistakes row recommended `setImmediate`, which the Determinism section
  forbids) and corrected the `enqueueBackgroundTask` seam signature to
  `cwd, job, request, deps`.
- **Docs:** refreshed a stale `resolveSandboxMode` line reference in
  `reliability-backlog.md`.

Suite: 300 tests, deterministic green (verified stable under 4x concurrent runs;
the apparent flake during multi-agent review was CPU contention from ~9 parallel
full-suite runners, not a suite defect).

## 1.0.14

Follow-up review fixes (verified against the current code; TDD, +9 tests):

- **SessionEnd no longer reaps the shared broker out from under an active
  background job (the real gap behind #355).** `handleSessionEnd` sent the
  graceful `broker/shutdown` RPC *unconditionally* before the background-job
  check — and the broker's busy-gate only refuses while another socket owns an
  in-flight request/stream, so a background job that is queued / connecting /
  between its `thread/start` and `turn/start` was not seen as busy and the broker
  would exit, orphaning that job's app-server. The RPC is now gated on
  `hasActiveBackgroundJobs` too (symmetric with the already-gated local teardown).
  `handleSessionEnd` is exported with an injectable deps seam and has an
  integration test.
- **The turn idle watchdog now actually interrupts the wedged turn.** An
  `ETURNIDLE` rejection (from `captureTurn`'s idle timer) previously took the
  plain-failure path: the job was marked failed but the orphan turn kept running
  on the shared broker (closing the socket does not stop it). `runTrackedJob` now
  treats `ETURNIDLE` like the hard-cap timeout — best-effort `turn/interrupt` +
  process-tree terminate — and tags the record `idleTimedOut`. (Still disabled by
  default; only arms when `CODEX_TURN_IDLE_TIMEOUT_MS` is set.)
- **A malformed `error` notification no longer crashes the host process.** The
  `case "error"` handler dereferenced `params.error.message` with no guard; a
  notification missing the `error` field threw a `TypeError` inside the stream
  listener (no try/catch), crashing the process. All dereferences are now guarded.
- **`stripAnsi` is linear again.** The OSC branch used an unbounded lazy
  `[\s\S]*?` that re-walked to end-of-string on every unterminated `ESC]` opener
  (O(n²) — a long opener-dense line stalled the broker line parser for seconds).
  Replaced with a bounded negated-class body + optional terminator.
- **`CODEX_SANDBOX_MODE` is validated.** A typo (e.g. `readonly`) was forwarded
  verbatim to the app-server (opaque `thread/start` failure); it now falls back to
  the default with a warning. The stale `resolveSandboxMode` comment is corrected,
  and the README's now-false "read-only / will not perform any changes" review
  claims are reworded with a new **Sandbox** section documenting the override.
- **`terminateProcessTree`'s `ps` read gets an explicit 16MB maxBuffer** so a very
  large process table can't truncate (ENOBUFS) into an empty descendant sweep.
- **Test hermeticity:** the harness now redirects `HOME`/`USERPROFILE` so
  cross-workspace lookups never read the developer's real `~/.claude`.
- **Docs:** `reliability-backlog.md` #3 (process-group reaping) marked DONE — it
  was implemented in 1.0.9 but still labelled a gap.

## 1.0.13

- **Default the sandbox to `danger-full-access` (hardcoded).** `resolveSandboxMode`
  now returns `danger-full-access` by default instead of preserving the requested
  `read-only`/`workspace-write` mode. This fork runs on hosts that cannot start
  Codex's `bwrap` sandbox (nested sandbox / restricted network namespace — bwrap
  aborts with `loopback: Failed RTM_NEWADDR: Operation not permitted` before any
  command runs), so Codex now always skips bwrap and reads files normally;
  isolation comes from the outer environment. `CODEX_SANDBOX_MODE` still overrides
  the default (e.g. `read-only` on a host where bwrap works). Note: upstream lists
  blanket `danger-full-access` as a do-not-adopt coercion; it is applied here
  deliberately for this fork's environment.

## 1.0.12

Reliability batch 4 (UX / observability) + the SessionEnd background-job decision:

- **Background jobs survive their session (decision on #355).** A `--background`
  job — especially a subagent-dispatched `--background` rescue — is designed to
  outlive the dispatching turn, but SessionEnd unconditionally terminated every
  session job (the subagent's turn end ≈ SessionEnd), killing the just-detached
  worker. Background jobs are now marked `background: true` and skipped by
  `cleanupSessionJobs` (kept running and retained in the index so the parent
  session's later `/codex:status` still finds them). The shared broker is also
  kept alive at SessionEnd while any background job is still active
  (`shouldTeardownBroker` + `hasActiveBackgroundJobs`), composing with the
  existing busy-gate. Background jobs remain bounded by the liveness watchdog and
  the 15-minute hard cap.
- **`/codex:attach` — live log tail.** New thin command that streams a job's log
  as it is produced and exits when the job reaches a terminal status. Resolves a
  job by id (local, then across workspaces) or the newest active job. The tail
  loop (`streamJobLog`) is seam-injectable and bounded by `maxPolls`.
- **Cross-workspace job lookup.** A job id obtained in one workspace no longer
  dead-ends as "Job not found" when queried from another: `findJobByIdAcrossWorkspaces`
  (+ `collectCandidateStateRoots`) is used as a read-only fallback for an explicit
  id not found locally. The default (no id) selection stays workspace/session-scoped.
- **Dispatch sentinel.** Background launches print a machine-readable
  `[[codex-task status=dispatched id=<id>]]` line so a consumer scanning stdout
  can detect the dispatch and capture the job id without parsing prose.
- **app-server type alignment (clean `npm run build`).** Aligned the JSON-RPC
  params with the current Codex app-server schema: declare the now-required
  `requestAttestation: false` capability (serde-default on the wire, so no
  behavior change) and drop the removed `experimentalRawEvents` thread-start field
  (Codex ignored it). `tsc` now passes with zero errors.

## 1.0.11

Reliability batch 3 (output & failure visibility):

- **Cap the adversarial-review prompt under the Codex input limit.** The prompt
  inlined the collected review content verbatim, so a large self-collected diff
  could blow past Codex's ~1 MB input hard limit and fail outright. The final
  rendered prompt is now capped (`MAX_REVIEW_PROMPT_BYTES`), truncating only the
  review input on a UTF-8 boundary (`truncateToByteBudget`, never splitting a
  multi-byte sequence) with a truncation notice — a huge diff degrades to a
  truncated-but-valid prompt instead of a hard failure.
- **Surface companion failures on stdout.** `main()` failures wrote only to
  stderr; the `codex:codex-rescue` subagent captures stdout only, so a failure
  was invisible to it (looked like an empty/successful result). Failures now also
  emit a structured `{"status":"error","error":"...","exitCode":1}` envelope on
  stdout (stderr keeps the human-readable message), and the rescue subagent
  surfaces it instead of swallowing it.
- **Short-circuit non-retryable turn errors.** An `error` notification only
  recorded the error and waited for `turn/completed` — which never arrives for a
  terminal failure (e.g. a permanent auth error), hanging the turn until the hard
  cap. The turn is now completed as failed when the error is non-retryable, using
  the protocol's authoritative `willRetry === false` signal (with a narrow
  permanent-auth regex fallback when `willRetry` is absent). Transient/server
  errors (429, 5xx, rate-limit, overloaded) are never short-circuited.

## 1.0.10

Reliability batch 2 (process / connection lifecycle):

- **Reap the codex app-server subtree on close (no orphaned MCP children).** The
  app-server spawns its own MCP/tool subprocesses; on POSIX `close()` used to send
  a bare `SIGTERM` to the direct child only, orphaning that subtree. `close()` now
  reaps the whole tree via `terminateProcessTree` on every platform.
- **`terminateProcessTree` reaches non-group-leader subtrees (POSIX).** It now
  enumerates descendant pids (best-effort, via `ps`; degrades to a plain kill if
  `ps` is unavailable) and signals them, and a `kill(-pid)` `ESRCH` (which also
  happens for a *live* process that is not a group leader, e.g. the codex
  app-server inside the broker's group) now falls back to a direct `kill(pid)` —
  only concluding the process is gone when that also `ESRCH`s. This also means a
  wedged tracked-job worker is now actually terminated on hard timeout (previously
  a silent no-op for a non-leader worker). The codex app-server is deliberately
  NOT spawned detached: keeping it in the broker's process group means the
  watchdog's `terminateProcessTree(brokerPid)` still reaps the whole subtree, with
  the descendant sweep covering both the close-from-codex and reap-from-broker
  paths — avoiding the orphan-on-reap regression that detaching would introduce.
- **Don't reuse a dead broker.** `ensureBrokerSession` now gates reuse on the
  recorded broker pid being alive (`isSessionStale`), not just the endpoint
  answering — a crashed broker can leave a lingering unix socket that still pings.

Deferred: stale broker after switching accounts (backlog #303). Replacing a
per-workspace *shared* broker on an account mismatch conflicts with the
shared-broker safety rules (busy-gated; never torn down unconditionally), and —
verified against the Codex source — reading `account/read` *through* the broker
cannot even detect an external switch (the long-lived app-server returns its own
stale cached account). A correct fix must probe fresh on-disk auth and replace
only an idle broker; tracked as a dedicated follow-up.

## 1.0.9

Reliability batch 1 (most-defensive, smallest, pure-backend fixes):

- **Robust stdout JSONL parsing.** `AppServerClientBase.handleLine` — the single
  chokepoint that parses raw Codex app-server stdout for both the direct client
  and the broker's in-process client — now strips ANSI/terminal escapes and skips
  any non-JSON line (launcher banners, stray logs) instead of tearing down the
  whole connection (and killing the running turn) on the first unparseable line.
  Only a line that *looks* like JSON yet fails to parse is still a fatal protocol
  error. New `lib/strings.mjs#stripAnsi` (ECMA-48 OSC + CSI incl. bracketed-paste)
  is a no-op on clean JSONL and never corrupts a JSON-encoded escape.
- **Hook stdin tolerates pipe jitter.** The SessionStart/End and stop-gate hooks
  shared a single-shot `fs.readFileSync(0)` with no error handling; an `EAGAIN`
  on a non-blocking pipe crashed the hook and dropped the `session_id`. Both now
  use `lib/hook-input.mjs#readHookInput`: a chunked read loop with a bounded
  EAGAIN/EWOULDBLOCK retry (budget resets on progress) that returns `{}` on empty
  input, jitter, or malformed JSON instead of throwing.
- **captureTurn idle watchdog.** Added an opt-in per-turn idle timer
  (`CODEX_TURN_IDLE_TIMEOUT_MS`, **disabled by default**) that resets on every
  inbound notification and, after a stretch of total silence, rejects with an
  error carrying the thread/turn id so a caller can interrupt + reap a wedged
  turn whose socket stayed open. Disabled by default because all delta
  notifications are opted out, so a healthy turn can legitimately be silent for
  minutes inside a single long item; background jobs keep the 15-minute hard cap.

## 1.0.8

- Fix two shared-broker correctness bugs found by a Codex review of 1.0.5–1.0.6:
  - SessionEnd no longer tears down the broker when it refuses shutdown as busy
    (`sendBrokerShutdown` now reports busy), so ending one session can't abort
    another client's in-flight Codex turn.
  - The liveness watchdog only reaps the broker for a genuine HUNG turn with
    thread/turn identity, an attempted-but-unconfirmed interrupt, and an
    unreachable broker — never for a DEAD job, a busy broker, or one still
    reachable.
- Harden the terminal-job CAS: the stored===null recreate fallbacks (runner
  success/failure and cancel) now go through the same O_EXCL claim, and a claim
  left behind by a crashed owner (dead pid + still-active job) is reclaimable so
  a job can't wedge un-finalizable.
- `reapStaleBroker` verifies process identity before escalating to SIGKILL, so a
  recycled pid (an unrelated process reusing the old broker's pid) is never
  killed.
- Document a known Windows limitation: an npm-installed `codex.cmd` shim can't be
  spawned with shell:false; a cmd.exe-wrapper fix is deferred until it can be
  validated on Windows.

## 1.0.7

- Add a `CODEX_SANDBOX_MODE` escape hatch. Codex normally runs commands in its
  own `bwrap` sandbox, which needs to create a network namespace; on hosts that
  forbid that (nested sandboxes / some containers, where `unshare --net` returns
  EPERM) even a `read-only` turn aborts with `bwrap: loopback: Failed
  RTM_NEWADDR` and Codex can't read the repo. Setting
  `CODEX_SANDBOX_MODE=danger-full-access` makes the plugin pass that sandbox mode
  to Codex so it skips bwrap; isolation is then provided by the outer
  environment. The per-command default (read-only / workspace-write) is
  unchanged when the variable is unset.

## 1.0.6

- `/codex:handoff` now **sends the composed GPT-5.5 prompt to Codex by default**
  and returns Codex's response (reflect → compose → run → bring back). Use
  `--print` (or `--prompt-only`) to only emit the prompt to paste yourself;
  `--background` runs it as a background job and `--write` lets a task edit code.
  Mode A (session review) stays read-only.

## 1.0.5

- Add the `/codex:handoff` command (build a paste-able GPT-5.5 prompt from the
  current session or a given task; never runs Codex itself).
- Default Codex delegation to `gpt-5.5` at `xhigh` reasoning effort; replace the
  internal `gpt-5-4-prompting` guidance with `gpt-5-5-prompting`.
- Reliability and correctness hardening (cross-referenced against the upstream
  Codex CLI): cross-process terminal-job CAS via an O_EXCL lock, atomic state
  writes, a time-bounded broker shutdown with guaranteed SessionEnd teardown,
  watchdog escalation that reaps a hung turn's broker, a busy-gated
  `broker/shutdown`, SIGKILL escalation for stale brokers, no-shell process
  spawns (Windows argument-injection fix), and several smaller fixes. Remove the
  fabricated `spark` model alias (`--model` is now forwarded verbatim).

## 1.0.0

- Initial version of the Codex plugin for Claude Code

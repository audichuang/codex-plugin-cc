---
name: reviewing-codex-runtime-changes
description: Quick-reference map of the landmines when reviewing a change to this repo's (codex-plugin-cc) broker, background-job state (state.mjs / tracked-jobs / job-control), app-server transport, captureTurn, watchdog, or session-lifecycle hooks. Pull it up before merging a reliability fix or when asked "is this change correct?" / "did we miss anything?" / "deep-check this". It does NOT teach reviewing — read the real source and reason adversarially as you always would. It points you straight at the cross-process spots where bugs have actually slipped through, plus the Codex runtime facts you'd otherwise re-derive every time. Worth a glance even on a "small" runtime tweak: the bugs here hide in orderings and races across files, not in the diff in front of you.
---

# Reviewing Codex runtime changes — the landmine map

You already know how to review: read the real source (not just the diff), name the concrete failure scenario, reproduce a real-looking finding with a tiny read-only script, and don't pad. This file is **not** that. It's the map of where the landmines are in this multi-process system — so you look in the right places and judge a fix against how Codex *actually* behaves, instead of re-deriving the same facts each pass.

## Codex runtime facts (verified against `../codex`; cached so you don't re-derive)

- `turn/start` is non-blocking — immediate `InProgress` ACK, work streams as notifications. A per-RPC timeout bounds only the ACK, never the turn.
- **Killing the worker or closing the socket does NOT stop a running turn.** It runs inside the broker-owned `codex app-server`; only a `turn/interrupt` routed by the broker, or reaping the broker, stops it. Any "stop the turn" logic that merely `terminateProcessTree`s the worker is incomplete.
- No app-server heartbeat and no per-turn idle abort. The only lower bound is the model-provider `stream_idle_timeout` (~5 min) and only while actively reading the model SSE.
- A client disconnect does not abort the in-flight turn — which is *why* the watchdog reaps the broker rather than just dropping the connection.

## Invariants (enforce; full text in CLAUDE.md "Gotchas")

- **(A)** terminal writes go through `applyJobPatchIfActive` / `claimTerminalTransition`, never a raw `writeJobFile`/`saveState`.
- **(B)** the shared per-workspace broker is never killed unconditionally (busy-gated, identity-verified, not while a background job is active).
- **(C)** tests are hermetic (`import "./helpers.mjs"`; see the `testing-with-seams` skill). **(D)** injectable seams preserved.

## Where bugs have actually slipped through (look here first)

- **Pruning** — never evict an active (queued/running) job: `saveState` deletes the per-job files of anything dropped from the index, and the watchdog reads those. Keep active jobs even beyond `MAX_JOBS`; prune only terminal ones.
- **Destructive action on stale state** — before terminating a pid, consult the per-job file (source of truth): if it's already terminal there, don't signal (the index pid may be reused); prefer the per-job pid over the index pid; CAS the transition. Residual you can't fully close: a worker SIGKILLed before writing a terminal status leaves a stale `running` + dead pid.
- **SessionEnd ordering** — the "is a background job active?" check must run **before** `sendBrokerShutdown` (the self-shutdown RPC), not only before the local teardown. `--background` jobs survive SessionEnd; foreground jobs are reaped.
- **captureTurn settle race** — the idle watchdog, the `exitPromise` transport-close watchdog, and `turn/completed` all settle `state.completion`. Check for no double-settle, no leaked timer (`clearIdleTimer` in `finally`), no unhandled rejection (handler attached early); arm the idle timer only *after* the ACK; the idle/timeout path must `turn/interrupt` via the broker (killing the worker doesn't stop the turn).
- **Stream / parse** — `handleLine` strips ANSI and skips a line whose first non-space char isn't `{`/`[`, so one bad stdout line never tears down the connection; line-buffered readers (`sendBrokerShutdown`) settle only on a **complete** line, never a partial chunk.
- **Broker lifecycle** — reuse needs a PID-alive probe (a wedged broker still answers a socket ping); reap is graceful SIGTERM → identity-verified SIGKILL, and the SIGTERM is intentionally *not* `/proc`-gated (that would break reaping on macOS/Windows).

## Before you bless it

A new test must go **RED when the fix is reverted** — green alone proves nothing. If the change touches timers/processes, the suite can flake under heavy *parallel* load (real timers under CPU contention); that's load, not a defect. Bump the version for any `plugins/codex` change.

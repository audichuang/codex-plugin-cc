---
name: navigating-codex-source
description: Map + tooling for verifying how the REAL Codex CLI behaves by reading its Rust source, instead of guessing. Use whenever a question about Codex runtime behavior comes up — app-server JSON-RPC (turn/start, turn/interrupt, notifications), the turn/session engine, streaming, sandbox/bwrap, timeouts, disconnect handling — and the answer needs to be grounded in source rather than memory. This plugin (codex-plugin-cc) drives the real Codex CLI, so its correctness depends on Codex's actual behavior; reach for this before answering "how does Codex do X?" or when a fix hinges on an app-server/turn/session internal. It tells you where the Codex source lives, that it's codegraph-indexed, and the exact files/symbols worth opening.
---

# Navigating the Codex source

The real Codex CLI lives in a **separate checkout**: `../codex` (a sibling of this plugin repo). It's the `codex-rs/` Rust workspace (~2,900 files) and is **codegraph-indexed**, so you can locate things fast instead of grepping blind. Ground claims about Codex behavior here — a careful read of this source is how every "how does Codex actually behave?" question in this project was settled.

## How to navigate

```bash
codegraph query  "<symbol or term>" -p ../codex -l 10   # fuzzy symbol search (fast)
codegraph callers "<symbol>" -p ../codex                # who calls it
codegraph callees "<symbol>" -p ../codex                # what it calls
codegraph impact  "<symbol>" -p ../codex                # blast radius
```

- **codegraph indexes symbols, not string literals.** For JSON-RPC method names (`"turn/start"`, `"item/completed"`) and event variant names, `grep -rn` the string instead.
- codegraph beats grep for "where is this function / who calls it"; grep wins for wire-protocol strings and config constants.
- After upstream updates the checkout, run `codegraph sync ../codex` so the index isn't stale.

## The map (where the answers were)

| Question | Crate / file | Symbol |
|---|---|---|
| JSON-RPC request dispatch | `codex-rs/app-server/src/message_processor.rs` | `ClientRequest::*` match, `run_request_with_context` |
| `turn/start` handling | `codex-rs/app-server/src/request_processors/turn_processor.rs` | `turn_start`, `turn_start_inner` |
| `turn/interrupt` handling | same file | `turn_interrupt`, `submit_core_op(Op::Interrupt)` |
| core event → client notification | `codex-rs/app-server/src/bespoke_event_handling.rs`, `app-server-protocol/src/protocol/event_mapping.rs` | `apply_bespoke_event_handling`, `emit_turn_completed_with_status` |
| the turn-running event loop | `codex-rs/app-server/src/request_processors/thread_lifecycle.rs` | the `select!` pulling `conversation.next_event()` |
| client-disconnect handling | `codex-rs/app-server/src/request_processors/thread_processor.rs` | `connection_closed` |
| wire types / notification method names | `codex-rs/app-server-protocol/src/protocol/` | `v2/turn.rs` (`TurnStatus`, `TurnStartResponse`), `common.rs` (`ServerNotification`) |
| transport the plugin uses | `codex-rs/app-server-transport/src/transport/stdio.rs` | line reader/writer (no timers) |
| the turn/session engine | `codex-rs/core/src/session/mod.rs` | `submit_user_input_with_client_user_message_id`, `next_event`, `interrupt_task` |
| cooperative abort + grace period | `codex-rs/core/src/tasks/mod.rs` | `handle_task_abort`, `GRACEFULL_INTERRUPTION_TIMEOUT_MS` |
| model-stream idle timeout / retries | `codex-rs/model-provider-info/src/lib.rs` | `DEFAULT_STREAM_IDLE_TIMEOUT_MS`, `DEFAULT_STREAM_MAX_RETRIES` |
| SSE read loop (where idle timeout fires) | `codex-rs/codex-api/src/sse/responses.rs` | `process_sse` |
| sandbox / bwrap (the plugin disables it) | `codex-rs/sandboxing/src/lib.rs`, `codex-rs/bwrap/` | `system_bwrap_warning`, bwrap spawn |

## Settled facts + their anchors (verified at commit `87b808bb57`)

These are the load-bearing behaviors. Re-confirm at the listed symbol if a fix depends on a detail not captured here.

- **`turn/start` is non-blocking** — returns an `InProgress` ACK immediately, work streams as notifications. `turn_processor.rs` `turn_start_inner` returns `TurnStartResponse{turn: InProgress}` right after `submit_user_input_*` (which is a channel send in `session/mod.rs`); `TurnStatus::InProgress` is a real variant in `v2/turn.rs`.
- **Killing the worker / closing the socket does NOT stop a turn** — it runs on a tokio task inside the broker-owned app-server (`core/src/tasks/mod.rs` spawns it; `session/mod.rs` `interrupt_task` is the only cooperative stop). Only `turn/interrupt` (routed by the broker) or reaping the broker stops it.
- **No app-server heartbeat / per-turn idle abort.** `stdio.rs` has no timers. The only lower bound is the model-provider `DEFAULT_STREAM_IDLE_TIMEOUT_MS` (300_000 = 5 min, × `DEFAULT_STREAM_MAX_RETRIES` = 5), applied in `codex-api` `process_sse` while reading the model SSE — not an app-server-level abort.
- **A client disconnect does not abort the in-flight turn** — the only `Op::Interrupt` is inside the explicit `turn/interrupt` RPC; `connection_closed` only clears bookkeeping. (This is why the plugin's watchdog must reap the broker.)

## Caveats

- The checkout is a **moving target** — line numbers drift between commits, so anchor on **symbols**, not line numbers, and note the commit you verified against (`git -C ../codex log --oneline -1`).
- If a symbol named here is gone, upstream renamed/moved it — re-locate with codegraph rather than assuming the fact changed.
- For how these facts bear on reviewing *our* code, see the `reviewing-codex-runtime-changes` skill.

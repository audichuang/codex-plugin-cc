# Changelog

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

// Liveness decision logic for the Codex job watchdog.
//
// Kept as pure functions so the "is this turn hung or just slow?" judgement —
// where false-positive kills would hurt most — is fully unit-testable without
// spawning processes or sockets. The watchdog executable wires these to real
// observations (process.kill(pid, 0), log mtime, a synthetic broker probe).

export const DEFAULTS = Object.freeze({
  intervalMs: 300_000, // 5 minutes
  hangQuietMs: 900_000, // 15 minutes of event silence (with broker unreachable)
  hardQuietMs: 1_800_000, // 30 minutes of silence — kill regardless of broker
  confirmRounds: 2 // consecutive bad ticks required before terminating
});

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Classify a job's liveness from one observation.
 *
 * - DONE    — the job already reached a terminal state; the watchdog can stop.
 * - DEAD    — the worker process is gone but the job never reached terminal.
 * - HUNG    — alive but silent past the hard ceiling, OR silent past the soft
 *             threshold while the broker is unreachable.
 * - HEALTHY — anything else, including a long-but-active run whose broker still
 *             answers (we must not kill a slow-but-working turn).
 */
export function classifyLiveness({ status, workerAlive, quietMs, brokerOk, thresholds } = {}) {
  if (TERMINAL_STATUSES.has(status)) {
    return "DONE";
  }
  if (!workerAlive) {
    return "DEAD";
  }
  const hangQuietMs = thresholds?.hangQuietMs ?? DEFAULTS.hangQuietMs;
  const hardQuietMs = thresholds?.hardQuietMs ?? DEFAULTS.hardQuietMs;
  if (quietMs > hardQuietMs) {
    return "HUNG";
  }
  if (quietMs > hangQuietMs && !brokerOk) {
    return "HUNG";
  }
  return "HEALTHY";
}

function positiveIntOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function resolveWatchdogConfig(env = {}) {
  return {
    intervalMs: positiveIntOr(env.CODEX_WATCHDOG_INTERVAL_MS, DEFAULTS.intervalMs),
    hangQuietMs: positiveIntOr(env.CODEX_WATCHDOG_HANG_QUIET_MS, DEFAULTS.hangQuietMs),
    hardQuietMs: positiveIntOr(env.CODEX_WATCHDOG_HARD_QUIET_MS, DEFAULTS.hardQuietMs),
    confirmRounds: positiveIntOr(env.CODEX_WATCHDOG_CONFIRM_ROUNDS, DEFAULTS.confirmRounds)
  };
}

/**
 * Stateful gate implementing escalate-not-kill: a DEAD/HUNG verdict must repeat
 * for `confirmRounds` consecutive ticks before the gate authorises a terminate.
 * A HEALTHY tick resets the counter, so a single transient stall never kills a
 * job that resumes producing events.
 */
export function createLivenessGate({ confirmRounds = DEFAULTS.confirmRounds } = {}) {
  let consecutiveBad = 0;

  return {
    assess(observation) {
      const verdict = classifyLiveness(observation);

      if (verdict === "DONE") {
        consecutiveBad = 0;
        return { verdict, action: "stop" };
      }
      if (verdict === "HEALTHY") {
        consecutiveBad = 0;
        return { verdict, action: "none" };
      }

      consecutiveBad += 1;
      if (consecutiveBad >= confirmRounds) {
        return { verdict, action: "terminate" };
      }
      return { verdict, action: "none" };
    }
  };
}

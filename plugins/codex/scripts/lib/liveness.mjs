// Liveness decision logic for the Codex job watchdog.
//
// Kept as pure functions so the "is this turn hung or just slow?" judgement —
// where false-positive kills would hurt most — is fully unit-testable without
// spawning processes or sockets. The watchdog executable wires these to real
// observations (process.kill(pid, 0), log mtime, a synthetic broker probe).

export const DEFAULTS = Object.freeze({
  intervalMs: 300_000, // 5 minutes
  hangQuietMs: 900_000, // 15 minutes of event silence (only kills WITH broker unreachable)
  confirmRounds: 2 // consecutive bad ticks required before terminating
});

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Classify a job's liveness from one observation.
 *
 * - DONE    — the job already reached a terminal state; the watchdog can stop.
 * - DEAD    — the worker process is gone but the job never reached terminal.
 * - HUNG    — alive but EITHER it blew past its own declared hard-timeout
 *             deadline (its in-process timeout should have fired but didn't —
 *             the event-loop-wedged case), OR it is silent past the soft
 *             threshold AND the broker is unreachable. Silence with a reachable
 *             broker is never fatal on its own: a reachable broker does not
 *             prove progress, so the watchdog must not false-kill a
 *             slow-but-working turn that is still within its budget.
 * - HEALTHY — anything else.
 */
export function classifyLiveness({ status, workerAlive, quietMs, brokerOk, missedOwnDeadline, thresholds } = {}) {
  if (TERMINAL_STATUSES.has(status)) {
    return "DONE";
  }
  if (!workerAlive) {
    return "DEAD";
  }
  // The worker failed to honour its own hard timeout (it would otherwise have
  // marked itself failed by now). This only triggers past the job's declared
  // deadline, so it never kills a turn that is still working within its budget.
  if (missedOwnDeadline) {
    return "HUNG";
  }
  const hangQuietMs = thresholds?.hangQuietMs ?? DEFAULTS.hangQuietMs;
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

// Tracks connected clients for the shared broker and fires `onIdle` once no
// clients remain for `timeoutMs`. Extracted as a pure unit (timers injectable)
// so the auto-exit policy is testable without spawning the broker. Prevents
// orphaned broker processes (and the Codex app-server they own) from
// accumulating across sessions.
export function createIdleTracker({ timeoutMs, onIdle, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let count = 0;
  let timer = null;

  function arm() {
    if (timer || count > 0) {
      return;
    }
    timer = setTimer(() => {
      timer = null;
      onIdle();
    }, timeoutMs);
    timer?.unref?.();
  }

  function cancel() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  return {
    connect() {
      count += 1;
      cancel();
    },
    disconnect() {
      if (count > 0) {
        count -= 1;
      }
      if (count === 0) {
        arm();
      }
    },
    idleStart() {
      arm();
    },
    get count() {
      return count;
    },
    get armed() {
      return timer !== null;
    }
  };
}

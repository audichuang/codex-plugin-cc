import fs from "node:fs";

// Shared stdin reader for the SessionStart/End and stop-gate hooks. Claude Code
// pipes a JSON payload to a hook's stdin; on a non-blocking pipe a synchronous
// read can throw EAGAIN/EWOULDBLOCK while the writer is mid-flight. A single
// fs.readFileSync(0) therefore crashes the hook on pipe jitter, dropping the
// session_id and desyncing broker lifecycle. This reads in a chunked loop with a
// bounded EAGAIN retry (the budget resets after any successful read) and never
// throws on jitter — it returns whatever it managed to read.

const DEFAULT_CHUNK_SIZE = 65536;
const DEFAULT_MAX_EAGAIN_RETRIES = 1000;
const DEFAULT_RETRY_DELAY_MS = 2;

// Synchronous sleep without busy-spinning: block this thread on an Int32 that is
// never notified, so Atomics.wait simply times out after `ms`.
function defaultSleep(ms) {
  if (!(ms > 0)) {
    return;
  }
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer/Atomics unavailable — fall back to a no-op; the retry
    // loop still progresses, just without the backoff pause.
  }
}

/**
 * Read all of a file descriptor synchronously, tolerating transient EAGAIN.
 * @param {number} fd
 * @param {{ readImpl?: Function, sleep?: Function, maxEagainRetries?: number, retryDelayMs?: number, chunkSize?: number }} [options]
 * @returns {string} UTF-8 contents (possibly empty)
 */
export function readStdinSync(fd = 0, options = {}) {
  const readImpl = options.readImpl ?? fs.readSync;
  const sleep = options.sleep ?? defaultSleep;
  const maxEagainRetries = options.maxEagainRetries ?? DEFAULT_MAX_EAGAIN_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;

  const buffer = Buffer.alloc(chunkSize);
  const chunks = [];
  let eagainRetries = 0;

  for (;;) {
    let bytesRead;
    try {
      bytesRead = readImpl(fd, buffer, 0, chunkSize, null);
    } catch (error) {
      const code = error?.code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") {
        if (eagainRetries >= maxEagainRetries) {
          break; // sustained stall — give up gracefully rather than crash
        }
        eagainRetries += 1;
        sleep(retryDelayMs);
        continue;
      }
      if (code === "EOF") {
        break; // some platforms surface EOF as an error
      }
      throw error;
    }

    if (bytesRead === 0) {
      break; // EOF
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    eagainRetries = 0; // progress made — reset the jitter budget
  }

  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read and parse a hook's JSON stdin payload. Returns {} on empty input, pipe
 * jitter, or malformed JSON — a hook must never crash on its input.
 * @param {object} [options] forwarded to readStdinSync (plus optional `fd`)
 * @returns {object}
 */
export function readHookInput(options = {}) {
  const fd = options.fd ?? 0;
  const raw = readStdinSync(fd, options).trim();
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

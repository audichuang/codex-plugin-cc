import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { isProcessAlive, terminateProcessTree } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// Mirrors BROKER_BUSY_RPC_CODE in app-server.mjs. Duplicated here (instead of
// imported) to avoid an app-server <-> broker-lifecycle import cycle.
const BROKER_BUSY_RPC_CODE = -32001;

// Returns { busy } — busy:true means the broker refused shutdown because it is
// still serving another client. The caller must NOT then tear the broker down.
export async function sendBrokerShutdown(endpoint, timeoutMs = 1500) {
  return await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    let settled = false;
    let busy = false;
    let buffer = "";
    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.destroy();
      } catch {
        // Best effort.
      }
      resolve({ busy });
    };
    socket.setEncoding("utf8");
    // Bound the wait: a broker that connects but never replies (and never
    // closes) would otherwise hang the caller forever. The SessionEnd hook has
    // a hard 5s budget, so this graceful RPC must self-terminate well before it.
    socket.setTimeout(timeoutMs, done);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line.trim()) {
          continue;
        }
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          // A complete-but-unparsable line: ignore it and keep waiting for a
          // valid reply (timeout/close still bound the wait).
          continue;
        }
        if (message?.error?.code === BROKER_BUSY_RPC_CODE) {
          busy = true;
        }
        // Only settle once a COMPLETE reply line has been parsed. Settling on a
        // partial chunk (the old `done()` after the loop) misread a fragmented
        // busy response as not-busy and let SessionEnd tear down a busy broker.
        done();
        return;
      }
      // No complete line yet — wait for the rest of the response.
    });
    socket.on("error", done);
    socket.on("close", done);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

function defaultForceKill(pid) {
  // SIGKILL the process group first (matches terminateProcessTree's group
  // signalling), then fall back to the bare pid.
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
      return;
    } catch {
      // Try the next target; if both fail the process is already gone.
    }
  }
}

// Confirm the pid is still OUR broker before a hard SIGKILL, so a recycled pid
// (the old broker exited and the OS reassigned its pid) is never killed. Reads
// /proc/<pid>/cmdline and requires it to be the broker script for this session's
// endpoint/pidFile. Returns false when identity cannot be established (no /proc
// on this OS, unreadable, or no match) — caller then leaves the process alone.
function defaultVerifyBrokerIdentity(pid, session) {
  let cmdline;
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
  } catch {
    return false;
  }
  if (!cmdline.includes("app-server-broker.mjs")) {
    return false;
  }
  return Boolean(
    (session?.endpoint && cmdline.includes(session.endpoint)) ||
      (session?.pidFile && cmdline.includes(session.pidFile))
  );
}

// Tear down a stale broker and, if it survives the graceful SIGTERM (its
// SIGTERM handler runs an async shutdown that can hang), escalate to SIGKILL
// before a replacement is spawned — otherwise two brokers can run at once.
export async function reapStaleBroker(session, options = {}) {
  const killProcess = options.killProcess ?? terminateProcessTree;
  const aliveCheck = options.isProcessAlive ?? isProcessAlive;
  const forceKill = options.forceKill ?? defaultForceKill;
  const verifyIdentity = options.verifyIdentity ?? defaultVerifyBrokerIdentity;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const escalateAfterMs = options.escalateAfterMs ?? 500;

  teardownBrokerSession({
    endpoint: session.endpoint ?? null,
    pidFile: session.pidFile ?? null,
    logFile: session.logFile ?? null,
    sessionDir: session.sessionDir ?? null,
    pid: session.pid ?? null,
    killProcess
  });

  const pid = session.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  const step = 50;
  let waited = 0;
  while (waited < escalateAfterMs && aliveCheck(pid)) {
    await sleep(step);
    waited += step;
  }
  // Only hard-kill if it is still alive AND still provably our broker — never
  // SIGKILL a process that merely reused the old pid.
  if (aliveCheck(pid) && verifyIdentity(pid, session)) {
    forceKill(pid);
  }
}

// A recorded session is stale if its broker pid is provably dead. A crashed
// broker can leave a lingering unix socket that still answers a ping, so reuse
// must be gated on the pid being alive — not just the endpoint responding —
// otherwise we adopt a dead broker and every turn fails. When the pid is unknown
// (null / non-integer) we cannot prove death and fall back to the endpoint check.
export function isSessionStale(session, options = {}) {
  const aliveCheck = options.isProcessAlive ?? isProcessAlive;
  const pid = Number(session?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  return !aliveCheck(pid);
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (
    existing &&
    !isSessionStale(existing, { isProcessAlive: options.isProcessAlive }) &&
    (await isBrokerEndpointReady(existing.endpoint))
  ) {
    return existing;
  }

  if (existing) {
    await reapStaleBroker(existing, {
      killProcess: options.killProcess ?? terminateProcessTree,
      isProcessAlive: options.isProcessAlive,
      forceKill: options.forceKill,
      sleep: options.sleep,
      escalateAfterMs: options.escalateAfterMs
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? terminateProcessTree
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null
  };
  saveBrokerSession(cwd, session);
  return session;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}

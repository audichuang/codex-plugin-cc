/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";
import { stripAnsi } from "./strings.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  // Required by the codex app-server InitializeCapabilities schema (serde-default
  // on the wire). We do not opt into attestation/generate requests.
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export function resolveRequestTimeoutMs(env = process.env) {
  const value = Number(env.CODEX_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return Math.trunc(value); // 0 disables the per-request timeout
}

export class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params, options = {}) {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : resolveRequestTimeoutMs(this.options?.env ?? process.env);

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method, timer: null };
      // Layer-0 backstop: a wedged broker can accept the socket but never
      // answer (startup races, a hung upstream). Without this the request
      // promise — and any awaiter — would hang forever. The long-running turn
      // is tracked via state.completion, not a request, so this never cuts a
      // working turn short.
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.get(id) === entry) {
            this.pending.delete(id);
            reject(new Error(`codex app-server request '${method}' timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      try {
        this.sendMessage({ id, method, params });
      } catch (error) {
        // A synchronous transport failure must not leave a leaked pending entry
        // (and armed timer) behind.
        this.pending.delete(id);
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    // Codex app-server stdout is pure JSONL, but the `codex` launcher (and a
    // Windows shell wrapper) can interleave non-JSON noise — banners, update
    // notices, stray log/ANSI output. Strip ANSI and skip any line that does not
    // look like JSON instead of tearing the whole connection down (which would
    // also kill the running turn) on the first unparseable line. Only a line
    // that *looks* like JSON yet fails to parse is treated as a real protocol
    // error.
    const cleaned = stripAnsi(line).trim();
    if (!cleaned) {
      return;
    }

    const first = cleaned[0];
    if (first !== "{" && first !== "[") {
      return;
    }

    let message;
    try {
      message = JSON.parse(cleaned);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (pending.timer) {
        clearTimeout(pending.timer);
      }

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      // handleLine is the single chokepoint all app-server notifications pass
      // through, and it runs synchronously inside the transport `data`/`line`
      // listener with NO try/catch above it. A handler throw (e.g. an unguarded
      // dereference on a notification whose shape changed across a Codex upgrade)
      // would otherwise become an uncaughtException that crashes the worker
      // mid-turn — the job then never records a terminal status and only surfaces
      // later as the cryptic "exited without reporting a terminal status" reconcile.
      // Contain it here so one unexpected notification can never kill the turn:
      // skip that notification and keep reading, mirroring the parse-noise policy
      // above. Logged (method + error) so the offending shape stays diagnosable.
      try {
        this.notificationHandler(/** @type {AppServerNotification} */ (message));
      } catch (error) {
        const detail = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(
          `[codex] notification handler threw for method=${message.method}; skipped to keep the turn alive: ${detail}\n`
        );
      }
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

export class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const detail =
        code === 0
          ? null
          : createProtocolError(`codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`);
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      const graceMs = this.options.closeGraceMs ?? 50;
      setTimeout(() => this.terminateChild(), graceMs).unref?.();
    }

    await this.exitPromise;
  }

  // Reap the codex app-server AND its subtree. The app-server spawns its own
  // MCP/tool subprocesses; a bare SIGTERM to the direct child orphans them. Use
  // terminateProcessTree on every platform (Windows: taskkill /T; POSIX: group
  // kill + descendant sweep via the codex pid). Best-effort: this runs inside an
  // unref'd timer during shutdown, so it must never throw.
  terminateChild() {
    if (!this.proc || this.proc.killed || this.proc.exitCode !== null) {
      return;
    }
    const terminate = this.options.terminateProcessTreeImpl ?? terminateProcessTree;
    try {
      terminate(this.proc.pid);
    } catch {
      // swallow — host process must not crash during shutdown
    }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = options.clientFactory
      ? options.clientFactory({ cwd, options, brokerEndpoint })
      : brokerEndpoint
        ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
        : new SpawnedCodexAppServerClient(cwd, options);

    try {
      await client.initialize();
    } catch (error) {
      // initialize() failed AFTER the client spawned its `codex app-server`
      // child / opened its socket. Close it before rethrowing so we never leak
      // a live process, readline interface, or stderr listener.
      await client.close().catch(() => {});
      throw error;
    }
    return client;
  }
}

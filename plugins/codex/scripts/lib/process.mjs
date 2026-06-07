import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const spawnImpl = options.spawnImpl ?? spawnSync;
  const result = spawnImpl(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    // Never run through a shell. spawnSync with shell:true concatenates the
    // args array into the command line WITHOUT escaping (Node DEP0190), so a
    // user-controlled value (e.g. a git `--base` ref or a changed-file path)
    // becomes shell injection on Windows. git/codex/taskkill are real
    // executables and resolve fine with shell:false.
    //
    // KNOWN LIMITATION (Windows): an npm-installed Codex is a `codex.cmd` shim,
    // which spawnSync cannot run with shell:false. The correct fix is to detect
    // .cmd/.bat and invoke them via `cmd.exe /d /s /c` with
    // windowsVerbatimArguments + our own quoting (the cross-spawn pattern) — NOT
    // shell:true with an args array. Deferred until it can be validated on
    // Windows; getting cmd.exe quoting wrong would either break execution or
    // reintroduce the injection this guards against.
    shell: false,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

// Best-effort snapshot of the POSIX process table as [{ pid, ppid }]. Returns []
// on any failure (ps missing, non-zero exit, unparseable) so callers degrade to
// a plain group/single kill rather than throwing.
function readProcessTable(options = {}) {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const result = runCommandImpl("ps", ["-A", "-o", "pid=,ppid="], {
    cwd: options.cwd,
    env: options.env,
    // The default spawnSync maxBuffer (~1MB) truncates a very large process table
    // into an ENOBUFS error, which this function swallows into an empty descendant
    // list — silently skipping the descendant sweep. ~16MB holds ~1M `pid ppid`
    // rows, well beyond any realistic table, so a busy host still reaps the subtree.
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    return [];
  }
  const table = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [pidStr, ppidStr] = trimmed.split(/\s+/);
    const pid = Number(pidStr);
    const ppid = Number(ppidStr);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) {
      table.push({ pid, ppid });
    }
  }
  return table;
}

// All descendant pids of rootPid (excluding rootPid itself), derived from a
// process table. A wedged child that is not a process-group leader cannot be
// reached by kill(-rootPid), so we enumerate and signal it directly.
function collectDescendantPids(rootPid, options = {}) {
  let table;
  try {
    table = options.psImpl ? options.psImpl() : readProcessTable(options);
  } catch {
    return [];
  }
  if (!Array.isArray(table) || table.length === 0) {
    return [];
  }
  const childrenOf = new Map();
  for (const entry of table) {
    const pid = Number(entry?.pid);
    const ppid = Number(entry?.ppid);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
      continue;
    }
    if (!childrenOf.has(ppid)) {
      childrenOf.set(ppid, []);
    }
    childrenOf.get(ppid).push(pid);
  }
  const descendants = [];
  const seen = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const child of childrenOf.get(current) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        descendants.push(child);
        stack.push(child);
      }
    }
  }
  return descendants;
}

export function isProcessAlive(pidValue) {
  const pid = Number(pidValue);
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(Math.trunc(pid), 0);
    return true;
  } catch (error) {
    // EPERM = process exists, we just lack permission to signal it.
    // ESRCH (or anything else) = treat as dead.
    return error?.code === "EPERM";
  }
}

export function terminateProcessTree(pid, options = {}) {
  // A pid must be a positive integer. Reject fractions/NaN/Infinity/<=0 so we
  // never derive a bogus target: kill(-pid)/`taskkill /PID String(pid)` on a
  // fractional or zero pid can hit the wrong process group. This matches the
  // guard in isProcessAlive.
  if (!Number.isInteger(pid) || pid <= 0) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  // POSIX: reap any descendant pids first (best-effort). kill(-pid) only reaches
  // a process group, so a child that is not itself a group leader (e.g. the
  // codex app-server's MCP/tool subprocesses) survives a bare group/single kill.
  for (const descendantPid of collectDescendantPids(pid, options)) {
    try {
      killImpl(descendantPid, "SIGTERM");
    } catch {
      // Best-effort: a descendant may have already exited (ESRCH) between the
      // snapshot and the signal; never let that abort reaping the rest.
    }
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    // kill(-pid) failed. ESRCH here only means "no such process GROUP" — which is
    // also the case for a LIVE process that is not a group leader (e.g. the codex
    // app-server spawned inside the broker's group). So always fall back to a
    // direct kill of the pid, and only conclude the process is gone when THAT
    // also reports ESRCH.
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw innerError;
    }
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

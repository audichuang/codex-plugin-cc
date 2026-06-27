import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveJobDoneFile } from "../plugins/codex/scripts/lib/state.mjs";
import { enqueueBackgroundTask, spawnDetachedTaskWorker } from "../plugins/codex/scripts/codex-companion.mjs";

test("enqueueBackgroundTask exposes the signal file and launches the watchdog", () => {
  const workspace = makeTempDir();
  const job = { id: "task-bg", workspaceRoot: workspace, title: "Codex task", summary: "do x" };

  const calls = { worker: [], watchdog: [] };
  const result = enqueueBackgroundTask(workspace, job, { kind: "task" }, {
    spawnWorker: (cwd, jobId) => {
      calls.worker.push([cwd, jobId]);
      return { pid: 4321 };
    },
    spawnWatchdog: (cwd, jobId) => {
      calls.watchdog.push([cwd, jobId]);
      return { pid: 4322 };
    }
  });

  assert.equal(result.payload.signalFile, resolveJobDoneFile(workspace, "task-bg"));
  assert.equal(result.signalFile, resolveJobDoneFile(workspace, "task-bg"));
  assert.deepEqual(calls.worker, [[workspace, "task-bg"]]);
  assert.deepEqual(calls.watchdog, [[workspace, "task-bg"]]);
  assert.equal(result.payload.status, "queued");
});

test("enqueueBackgroundTask still launches the task when the watchdog fails to start", () => {
  const workspace = makeTempDir();
  const job = { id: "task-bg2", workspaceRoot: workspace, title: "Codex task", summary: "do y" };

  let workerLaunched = false;
  const result = enqueueBackgroundTask(workspace, job, { kind: "task" }, {
    spawnWorker: () => {
      workerLaunched = true;
      return { pid: 1 };
    },
    spawnWatchdog: () => {
      throw new Error("watchdog boom");
    }
  });

  assert.equal(workerLaunched, true);
  assert.equal(result.payload.status, "queued");
  assert.equal(result.payload.signalFile, resolveJobDoneFile(workspace, "task-bg2"));
});

// The detached background worker was spawned with stdio:"ignore", so a crash
// stack (the app-server dispatch guard's diagnostic, or the crash-net's logging)
// went to /dev/null in background mode — exactly the forensics you want under
// daily Codex churn. Route the worker's stderr (fd2) into the job log instead.
test("spawnDetachedTaskWorker routes the worker stderr (fd2) into the job log file", () => {
  const stdioSeen = [];
  let openedPath = null;
  let closedFd = null;

  const child = spawnDetachedTaskWorker("/ws", "task-x", "/ws/jobs/task-x.log", {
    spawnImpl: (_cmd, _args, opts) => {
      stdioSeen.push(opts.stdio);
      return { unref() {}, pid: 4242 };
    },
    openLog: (p) => {
      openedPath = p;
      return 77; // sentinel fd
    },
    closeLog: (fd) => {
      closedFd = fd;
    }
  });

  assert.equal(openedPath, "/ws/jobs/task-x.log", "the job log is opened for the worker stderr");
  assert.deepEqual(stdioSeen[0], ["ignore", "ignore", 77], "fd2 is the opened job log, not /dev/null");
  assert.equal(closedFd, 77, "the parent closes its copy of the inherited fd after spawn");
  assert.equal(child.pid, 4242);
});

test("spawnDetachedTaskWorker falls back to ignore when there is no log file", () => {
  const stdioSeen = [];
  spawnDetachedTaskWorker("/ws", "task-y", null, {
    spawnImpl: (_cmd, _args, opts) => {
      stdioSeen.push(opts.stdio);
      return { unref() {} };
    },
    openLog: () => {
      throw new Error("openLog must not be called when there is no log file");
    }
  });
  assert.deepEqual(stdioSeen[0], ["ignore", "ignore", "ignore"]);
});

import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveJobDoneFile } from "../plugins/codex/scripts/lib/state.mjs";
import { enqueueBackgroundTask } from "../plugins/codex/scripts/codex-companion.mjs";

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

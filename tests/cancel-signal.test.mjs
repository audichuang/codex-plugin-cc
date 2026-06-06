import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import {
  readJobFile,
  resolveJobDoneFile,
  resolveJobFile,
  resolveJobLogFile,
  saveState,
  writeCompletionSignalFile,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

test("cancel writes a cancelled .done signal so a waiting monitor wakes", () => {
  const workspace = makeTempDir();
  const jobId = "job-cancel";
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.writeFileSync(logFile, "", "utf8");

  // A real, throwaway child so the job stays "running" (dead-PID reconcile does
  // not flip it before cancel runs). cancel's terminateProcessTree kills it.
  const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });

  try {
    const job = {
      id: jobId,
      status: "running",
      phase: "investigating",
      pid: dummy.pid,
      logFile,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    writeJobFile(workspace, jobId, job);
    saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });

    const result = run("node", [SCRIPT, "cancel", jobId, "--cwd", workspace, "--json"], { cwd: workspace });
    assert.equal(result.status, 0, `cancel exited non-zero: ${result.stderr}`);

    const doneFile = resolveJobDoneFile(workspace, jobId);
    assert.equal(fs.existsSync(doneFile), true);
    assert.equal(JSON.parse(fs.readFileSync(doneFile, "utf8")).status, "cancelled");
  } finally {
    try {
      process.kill(dummy.pid, "SIGKILL");
    } catch {
      // already terminated by cancel
    }
  }
});

test("cancel does not clobber a job that reached a terminal state during the cancel handler", () => {
  const workspace = makeTempDir();
  const jobId = "job-cancel-race";
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.writeFileSync(logFile, "", "utf8");

  // TOCTOU: resolveCancelableJob reads the index and sees the job as running,
  // but by the time cancel performs its durable write the worker process has
  // already finalized the per-job file as completed and written a completed
  // .done. cancel must read the per-job file through the CAS and NOT stomp the
  // terminal record/signal back to "cancelled" — first terminal writer wins.
  const completedRecord = {
    id: jobId,
    status: "completed",
    phase: "done",
    pid: null,
    logFile,
    result: { ok: true },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z"
  };
  writeJobFile(workspace, jobId, completedRecord);
  writeCompletionSignalFile(workspace, jobId, { status: "completed" });
  // Index still advertises the job as running (pid:null so dead-PID reconcile
  // leaves it alone) so resolveCancelableJob returns it.
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ ...completedRecord, status: "running", phase: "running", pid: null, completedAt: undefined }]
  });

  const result = run("node", [SCRIPT, "cancel", jobId, "--cwd", workspace, "--json"], { cwd: workspace });
  assert.equal(result.status, 0, `cancel exited non-zero: ${result.stderr}`);

  assert.equal(
    readJobFile(resolveJobFile(workspace, jobId)).status,
    "completed",
    "the terminal per-job record must not be clobbered to cancelled"
  );
  assert.equal(
    JSON.parse(fs.readFileSync(resolveJobDoneFile(workspace, jobId), "utf8")).status,
    "completed",
    "the terminal .done signal must not be overwritten with cancelled"
  );
});

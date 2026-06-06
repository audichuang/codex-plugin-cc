import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import {
  resolveJobDoneFile,
  resolveJobLogFile,
  saveState,
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

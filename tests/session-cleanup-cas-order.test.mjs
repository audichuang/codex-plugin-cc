import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { makeTempDir } from "./helpers.mjs"; // hermetic env + fs isolation
import { writeJobFile, saveState, resolveJobDoneFile } from "../plugins/codex/scripts/lib/state.mjs";
import { cleanupSessionJobs } from "../plugins/codex/scripts/session-lifecycle-hook.mjs";

// Regression (Codex deep-review MAJOR): cleanupSessionJobs terminated job.pid
// (from the possibly-stale INDEX) BEFORE the CAS terminal transition. On a stale
// index row whose job had already finished and whose pid was reused, that
// SIGTERM'd an unrelated process. The fix: CAS first, terminate only when we win
// the transition, and signal the pid from the freshly-read per-job record.

test("cleanupSessionJobs CASes before terminating and signals the authoritative per-job pid (not the stale index pid)", () => {
  const cwd = makeTempDir();
  // Per-job file (source of truth): still running, real worker pid 55555.
  writeJobFile(cwd, "j1", { id: "j1", status: "running", pid: 55555, sessionId: "s1", logFile: null });
  // Index row carries a STALE pid (11111) — what the old code would have killed.
  saveState(cwd, { jobs: [{ id: "j1", status: "running", pid: 11111, sessionId: "s1", logFile: null }] });

  const killed = [];
  cleanupSessionJobs(cwd, "s1", { terminateProcessTree: (pid) => killed.push(pid) });

  assert.deepEqual(killed, [55555], "must terminate the per-job-file pid, never the stale index pid");
});

test("cleanupSessionJobs does NOT terminate or signal a job that is already terminal in its per-job file", () => {
  const cwd = makeTempDir();
  // Per-job file says completed; the index row is stale ("running").
  writeJobFile(cwd, "j2", { id: "j2", status: "completed", pid: 55555, sessionId: "s2", logFile: null });
  saveState(cwd, { jobs: [{ id: "j2", status: "running", pid: 55555, sessionId: "s2", logFile: null }] });

  const killed = [];
  cleanupSessionJobs(cwd, "s2", { terminateProcessTree: (pid) => killed.push(pid) });

  assert.deepEqual(killed, [], "a job already terminal in its per-job file must not be signalled (CAS loses)");
  assert.equal(
    fs.existsSync(resolveJobDoneFile(cwd, "j2")),
    false,
    "no completion signal must be written when the CAS does not apply"
  );
});

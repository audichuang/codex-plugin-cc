import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  applyJobPatchIfActive,
  listJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

function seedActiveJob(workspace, overrides = {}) {
  const job = {
    id: overrides.id ?? "task-seed",
    status: overrides.status ?? "running",
    phase: overrides.phase ?? "investigating",
    pid: overrides.pid ?? process.pid,
    logFile: overrides.logFile ?? resolveJobLogFile(workspace, overrides.id ?? "task-seed"),
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
  writeJobFile(workspace, job.id, job);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });
  return job;
}

test("applyJobPatchIfActive applies patch and updates both persistence layers", () => {
  const workspace = makeTempDir();
  const job = seedActiveJob(workspace);

  const result = applyJobPatchIfActive(workspace, job.id, {
    status: "failed",
    phase: "failed",
    errorMessage: "boom"
  });

  assert.equal(result.applied, true);
  assert.equal(result.stored.status, "running");
  assert.equal(result.patch.status, "failed");

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.errorMessage, "boom");

  const state = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
  assert.equal(state.jobs[0].status, "failed");
});

test("applyJobPatchIfActive skips writes when the job is already terminal", () => {
  const workspace = makeTempDir();
  const job = seedActiveJob(workspace, { id: "task-terminal", status: "completed" });

  const result = applyJobPatchIfActive(workspace, job.id, {
    status: "failed",
    errorMessage: "would clobber"
  });

  assert.equal(result.applied, false);
  assert.equal(result.stored.status, "completed");

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.errorMessage, undefined);
});

test("applyJobPatchIfActive runs extraGuard in addition to the built-in active-state check", () => {
  const workspace = makeTempDir();
  const job = seedActiveJob(workspace, { id: "task-pid-guard", pid: 99001 });

  const matchingPid = applyJobPatchIfActive(
    workspace,
    job.id,
    { status: "failed" },
    (stored) => stored.pid === 99001
  );
  assert.equal(matchingPid.applied, true);

  seedActiveJob(workspace, { id: "task-pid-guard", pid: 99001 });

  const mismatchPid = applyJobPatchIfActive(
    workspace,
    "task-pid-guard",
    { status: "failed", errorMessage: "wrong pid" },
    (stored) => stored.pid === 77777
  );
  assert.equal(mismatchPid.applied, false);

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, "task-pid-guard"), "utf8"));
  assert.equal(persisted.status, "running");
  assert.equal(persisted.errorMessage, undefined);
});

test("applyJobPatchIfActive never bypasses the active-state check even if extraGuard returns true for a terminal record", () => {
  const workspace = makeTempDir();
  seedActiveJob(workspace, { id: "task-terminal-extra", status: "failed" });

  const result = applyJobPatchIfActive(
    workspace,
    "task-terminal-extra",
    { status: "completed", errorMessage: "would overwrite" },
    () => true // extraGuard says yes, but the built-in gate must still veto
  );
  assert.equal(result.applied, false);

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, "task-terminal-extra"), "utf8"));
  assert.equal(persisted.status, "failed");
});

test("applyJobPatchIfActive stamps updatedAt on every applied patch", () => {
  const workspace = makeTempDir();
  const job = seedActiveJob(workspace, { id: "task-updated-at" });
  const before = new Date().toISOString();

  const result = applyJobPatchIfActive(workspace, job.id, { phase: "verifying" });

  assert.equal(result.applied, true);
  assert.ok(result.patch.updatedAt, "returned patch must include updatedAt");
  assert.ok(result.patch.updatedAt >= before, "updatedAt must be recent");

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
  assert.equal(persisted.updatedAt, result.patch.updatedAt);
});

test("applyJobPatchIfActive returns applied=false when the per-job file is missing", () => {
  const workspace = makeTempDir();
  // Don't seed anything. Helper must not throw.
  const result = applyJobPatchIfActive(workspace, "task-missing", { status: "failed" });
  assert.equal(result.applied, false);
  assert.equal(result.stored, null);
});

test("listJobs auto-reconciles a running job when its tracked pid is dead", () => {
  const workspace = makeTempDir();
  const deadPid = 2147483645; // well above PID_MAX on Linux/macOS
  const job = seedActiveJob(workspace, { id: "task-zombie", pid: deadPid });

  const [reconciled] = listJobs(workspace);

  assert.equal(reconciled.status, "failed");
  assert.equal(reconciled.phase, "failed");
  assert.equal(reconciled.pid, null);
  assert.equal(reconciled.autoReconciled, true);
  assert.equal(reconciled.reconciledDeadPid, deadPid);
  assert.match(reconciled.errorMessage ?? "", /exited without reporting/);

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.autoReconciled, true);
});

test("listJobs leaves running jobs alone when the tracked pid is alive", () => {
  const workspace = makeTempDir();
  seedActiveJob(workspace, { id: "task-live", pid: process.pid });

  const [job] = listJobs(workspace);
  assert.equal(job.status, "running");
  assert.equal(job.pid, process.pid);
});

test("listJobs reconciliation TOCTOU guard: skips when persisted state already moved past active", () => {
  const workspace = makeTempDir();
  const deadPid = 2147483644;

  // Seed the state.json index with status:"running" but write the per-job file
  // as status:"completed". This simulates a race where the job completed
  // legitimately between the listJobs read and the reconcile write.
  const completedJob = {
    id: "task-race-completed",
    status: "completed",
    phase: "done",
    pid: null,
    logFile: resolveJobLogFile(workspace, "task-race-completed"),
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z"
  };
  writeJobFile(workspace, completedJob.id, completedJob);
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ ...completedJob, status: "running", pid: deadPid }]
  });

  const [job] = listJobs(workspace);
  // Reconciler must NOT downgrade the persisted "completed" record.
  assert.equal(job.status, "running"); // state.json index still shows running (reconcile saw dead PID but skipped)
  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, completedJob.id), "utf8"));
  assert.equal(persisted.status, "completed"); // per-job file preserved
  assert.equal(persisted.autoReconciled, undefined);
});

test("listJobs reconciles dead-PID queued jobs so a crashed background launcher cannot block future tasks", () => {
  // Regression for the blocker found in the third Codex review round:
  // `/codex:rescue --background` persists the record as status:"queued"
  // with the detached child's pid, and only flips to "running" after the
  // worker takes over. If the worker dies before that promotion, the
  // record must still be reconciled — otherwise it stays "queued" forever
  // and the active-job guard in codex-companion.mjs treats it as a live
  // task and rejects every subsequent /codex:rescue dispatch.
  const workspace = makeTempDir();
  const deadPid = 2147483642;
  seedActiveJob(workspace, {
    id: "task-dead-queued",
    status: "queued",
    phase: "queued",
    pid: deadPid
  });

  const [reconciled] = listJobs(workspace);

  assert.equal(reconciled.status, "failed");
  assert.equal(reconciled.autoReconciled, true);
  assert.equal(reconciled.reconciledDeadPid, deadPid);
});

test("listJobs reconciliation PID-identity guard: skips when persisted pid no longer matches", () => {
  const workspace = makeTempDir();
  const deadPidObservedByIndex = 2147483643;
  const differentPidInFile = 55555;

  const job = {
    id: "task-pid-drift",
    status: "running",
    phase: "investigating",
    pid: differentPidInFile,
    logFile: resolveJobLogFile(workspace, "task-pid-drift"),
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  writeJobFile(workspace, job.id, job);
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ ...job, pid: deadPidObservedByIndex }]
  });

  listJobs(workspace);

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
  // Per-job file pid disagrees with the dead-pid candidate, so reconcile skipped.
  assert.equal(persisted.status, "running");
  assert.equal(persisted.autoReconciled, undefined);
});

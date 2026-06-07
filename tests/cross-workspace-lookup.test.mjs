import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs"; // hermetic env isolation (sets CLAUDE_PLUGIN_DATA to a temp dir)
import {
  collectCandidateStateRoots,
  findJobByIdAcrossWorkspaces
} from "../plugins/codex/scripts/lib/state.mjs";
import { buildSingleJobSnapshot } from "../plugins/codex/scripts/lib/job-control.mjs";

const STATE_ROOT = path.join(process.env.CLAUDE_PLUGIN_DATA, "state");

function seedJobInWorkspaceDir(workspaceDirName, job) {
  const jobsDir = path.join(STATE_ROOT, workspaceDirName, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, `${job.id}.json`), JSON.stringify(job));
}

test("collectCandidateStateRoots includes the configured plugin-data state root", () => {
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  const roots = collectCandidateStateRoots("/some/cwd");
  assert.ok(roots.includes(STATE_ROOT), "the active CLAUDE_PLUGIN_DATA/state root must be a candidate");
});

test("findJobByIdAcrossWorkspaces finds a job stored under a sibling workspace state dir", () => {
  const job = {
    id: "job-cross-unique-abc",
    workspaceRoot: "/home/user/projectB",
    status: "running",
    phase: "investigating",
    pid: process.pid,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  seedJobInWorkspaceDir("projectB-deadbeefdeadbeef", job);

  const found = findJobByIdAcrossWorkspaces("/home/user/projectA", "job-cross-unique-abc");
  assert.ok(found, "the job from workspace B must be found from workspace A");
  assert.equal(found.job.id, "job-cross-unique-abc");
  assert.equal(found.job.workspaceRoot, "/home/user/projectB");
  assert.equal(found.workspaceStateDir, path.join(STATE_ROOT, "projectB-deadbeefdeadbeef"));
});

test("findJobByIdAcrossWorkspaces returns null for an unknown id (exact match only)", () => {
  assert.equal(findJobByIdAcrossWorkspaces("/x", "no-such-job-id-zzz"), null);
});

test("findJobByIdAcrossWorkspaces matches the full id only, not a prefix", () => {
  seedJobInWorkspaceDir("projectC-cafecafecafecafe", {
    id: "review-1234567890",
    workspaceRoot: "/home/user/projectC",
    status: "completed",
    phase: "done"
  });
  // a prefix must NOT match (cross-workspace fallback is for explicit full ids)
  assert.equal(findJobByIdAcrossWorkspaces("/x", "review-12345"), null);
  assert.ok(findJobByIdAcrossWorkspaces("/x", "review-1234567890"));
});

test("buildSingleJobSnapshot falls back to a cross-workspace job for an explicit id not found locally", () => {
  const localCwd = makeTempDir(); // an empty local workspace
  seedJobInWorkspaceDir("projD-1111111111111111", {
    id: "task-foreign-9999",
    workspaceRoot: "/home/user/projD",
    status: "completed",
    phase: "done",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z"
  });
  const snap = buildSingleJobSnapshot(localCwd, "task-foreign-9999");
  assert.equal(snap.job.id, "task-foreign-9999");
  assert.equal(snap.crossWorkspace, true, "a cross-workspace hit must be flagged");
});

test("buildSingleJobSnapshot still throws for an explicit id absent from every workspace", () => {
  const localCwd = makeTempDir();
  assert.throws(() => buildSingleJobSnapshot(localCwd, "totally-unknown-id-zzz"), /No job found/i);
});

test("buildSingleJobSnapshot with no reference stays workspace-scoped (no cross-workspace selection)", () => {
  const localCwd = makeTempDir();
  // A foreign active job exists, but a no-reference call must NOT select it.
  seedJobInWorkspaceDir("projE-2222222222222222", {
    id: "task-foreign-E",
    workspaceRoot: "/home/user/projE",
    status: "running",
    phase: "investigating",
    pid: process.pid,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  assert.throws(() => buildSingleJobSnapshot(localCwd, undefined), /No job found|No .*job/i);
});

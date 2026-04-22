import test from "node:test";
import assert from "node:assert/strict";

import { renderJobStatusReport, renderReviewResult, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});

test("renderJobStatusReport surfaces timedOut jobs without the misleading 'aborted' wording", () => {
  const output = renderJobStatusReport({
    id: "task-timeout-render",
    status: "failed",
    phase: "failed",
    timedOut: true,
    title: "Long-running task",
    errorMessage:
      "Tracked job task-timeout-render exceeded the 15m hard timeout; the job record was marked failed. The underlying runner was not cancelled and may still be executing in the background — kill it manually if it keeps consuming resources.",
    duration: "15m 1s",
    jobClass: "task",
    kindLabel: "rescue"
  });

  // New wording must be present
  assert.match(output, /Hard timeout: job marked failed after exceeding the configured duration\./);
  assert.match(output, /underlying runner was not cancelled and may still be executing/);
  // Misleading wording from the prior version must NOT be present
  assert.doesNotMatch(output, /runner watchdog aborted the job/);
  // Error message must still be rendered
  assert.match(output, /Error: Tracked job task-timeout-render exceeded the 15m hard timeout/);
});

test("renderJobStatusReport surfaces autoReconciled jobs with PID context", () => {
  const output = renderJobStatusReport({
    id: "task-zombie-render",
    status: "failed",
    phase: "failed",
    autoReconciled: true,
    reconciledDeadPid: 90016,
    title: "Dead companion",
    errorMessage: "Worker process PID 90016 exited without reporting a terminal status; auto-reconciled as failed.",
    duration: "13m 36s",
    jobClass: "task",
    kindLabel: "rescue"
  });

  assert.match(output, /Auto-reconciled as failed: worker process \(PID 90016\) exited without reporting\./);
});

import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { renderQueuedTaskLaunch } from "../plugins/codex/scripts/codex-companion.mjs";

test("renderQueuedTaskLaunch emits a machine-readable dispatch sentinel with the job id", () => {
  const out = renderQueuedTaskLaunch({ title: "Codex rescue", jobId: "task-abc123" });
  // human line preserved
  assert.match(out, /started in the background as task-abc123/);
  // machine-readable sentinel line for consumers that scan stdout
  assert.match(out, /\[\[codex-task status=dispatched id=task-abc123\]\]/);
});

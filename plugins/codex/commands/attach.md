---
description: Attach to a running Codex background job and stream its live log until it finishes
argument-hint: '[job-id] [--poll-interval-ms <ms>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" attach "$ARGUMENTS"`

This streams the job's log as it is produced and returns once the job reaches a
terminal status (completed / failed / cancelled).

- If the user passed a job ID, attach to that job (it may belong to another
  workspace — the id is resolved across workspaces when not found locally).
- If the user passed no job ID, attach to the newest still-active job in this
  repository.
- Present the streamed log output to the user as-is. Do not summarize or condense it.
- When the stream ends, point the user at `/codex:result <id>` for the final
  result and `/codex:status` for a one-line summary.

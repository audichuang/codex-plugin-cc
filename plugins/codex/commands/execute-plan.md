---
description: Read a plan file and hand it to Codex for full implementation with write access
argument-hint: '[plan-file-path] [--background|--wait] [--model <model>] [--effort <effort>]'
allowed-tools: Read, Glob, Bash(node:*), Bash(cat:*), Bash(mktemp:*), AskUserQuestion
---

Read a plan file and delegate its implementation to Codex with write access.

Raw slash-command arguments:
`$ARGUMENTS`

## Step 1: Locate the plan file

- If the user provided a file path in `$ARGUMENTS` (anything that looks like a path, e.g. `plan.md`, `./PLAN.md`, `.planning/phase-1/PLAN.md`), use that path directly.
- If no path was provided, search for plan files:
  1. `Glob("**/*PLAN*.md")` — look for any plan-like markdown file
  2. Also check `.planning/**/PLAN.md` and common locations
- If multiple plan files are found, use `AskUserQuestion` to let the user pick one.
- If no plan file is found, use `AskUserQuestion` to ask the user for the path.

## Step 2: Read and validate the plan

- Use `Read` to load the plan file content.
- Confirm the file is non-empty and looks like an actionable plan (has steps, tasks, or implementation details).
- If the content looks like a high-level outline with no concrete implementation steps, warn the user and ask whether to proceed.

## Step 3: Build the prompt file

- Create a temporary prompt file that wraps the plan with execution instructions:

```bash
TMPFILE=$(mktemp /tmp/codex-plan-prompt.XXXXXX.md)
```

- Write the following content to the temp file using `cat <<'PLAN_EOF' > "$TMPFILE"`:

```
You are given an implementation plan. Execute every step in order.

Rules:
- Implement each step fully. Do not skip steps or leave TODOs.
- After completing each logical group of changes, verify the code compiles/runs if applicable.
- If a step is ambiguous, make a reasonable choice and note what you assumed.
- Commit after each major step with a clear commit message describing what was done.

---

PLAN:

[INSERT PLAN CONTENT HERE]
```

## Step 4: Determine execution mode

- Extract `--background`, `--wait`, `--model`, and `--effort` from `$ARGUMENTS` if present.
- If neither `--background` nor `--wait` is specified:
  - Estimate plan size: count the number of steps/tasks in the plan.
  - If the plan has more than 3 steps or looks substantial, recommend background.
  - Use `AskUserQuestion` exactly once with two options, recommended first:
    - `Run in background` (suffix with `(Recommended)` if plan is substantial)
    - `Wait for results` (suffix with `(Recommended)` if plan is tiny)

## Step 5: Execute

- Build the command. Always include `--write` and `--prompt-file`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --write --prompt-file "$TMPFILE" [--model <model>] [--effort <effort>]
```

Foreground flow:
- Run the command directly.
- Return Codex output verbatim.
- Clean up the temp file after completion.

Background flow:
- Launch with `Bash` in background mode:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --write --prompt-file "$TMPFILE" [--model <model>] [--effort <effort>]`,
  description: "Codex execute plan",
  run_in_background: true
})
```
- Tell the user: "Codex is implementing your plan in the background. Use `/codex:status` to check progress, `/codex:result` to see the output when done."

## Operating rules

- This command is execution-focused. Codex will make changes to the codebase.
- Always use `--write` — the entire point of this command is to implement code.
- Return Codex output verbatim. Do not paraphrase or summarize.
- Clean up the temp prompt file after Codex finishes (foreground) or note its path (background).
- Do not fix, review, or modify Codex's output yourself.

---
description: Build a GPT-5.5 prompt for Codex — by default, a review of the work just done in this session — for you to paste into Codex
argument-hint: '[task description — omit to reflect on the work done in this session]'
allowed-tools: Read, Glob, Grep, Bash(git:*), Skill
---

Build a complete, copy-paste GPT-5.5 prompt for the user to hand to Codex (or any GPT-5.5 surface). This command only **produces the prompt** — it does not run Codex. The user will paste the prompt into Codex themselves and bring the response back.

Raw slash-command arguments:
`$ARGUMENTS`

First, load the prompt methodology:
- Use the `gpt-5-5-prompting` skill (via the `Skill` tool) and follow it when composing the prompt: outcome-first, success criteria, decision rules instead of blanket `ALWAYS`/`NEVER`, explicit stop rules, absolute file paths, and the suggested structure (`Role` / `Goal` / `Success criteria` / `Constraints` / `Output` / `Stop rules`).

## Mode A — no arguments: review handoff for the work just done

When `$ARGUMENTS` is empty, build a prompt that asks Codex to **review the work completed in this session**:

1. Reconstruct what changed. Use the working tree and history, e.g.:
   - `git --no-pager status --short`
   - `git --no-pager diff --stat` and `git --no-pager diff` for unstaged work
   - `git --no-pager diff --stat --cached` for staged work
   - `git --no-pager log --oneline -10` and `git --no-pager diff <base>...HEAD` if the work is committed on a branch
   Combine that with what you did in this conversation (the intent, the decisions, the trade-offs).
2. Compose a **code-review** prompt using the `gpt-5-5-prompting` methodology and the code-review recipe: a senior-engineer Role, a Goal of finding bugs / contract violations / maintainability / security issues, Success criteria (file:line + severity, fix snippets, "no issues found in X" when clean), Constraints (don't pad, mark "Need to verify"), and Stop rules.
3. List the changed files as **absolute paths** under a "Files to read" section, and tell Codex to read them itself (do NOT ask anyone to paste code). Add a one-paragraph "Context" describing what this change set was trying to achieve and any decisions worth challenging.

## Mode B — with arguments: build a prompt for that task

When `$ARGUMENTS` is non-empty, treat it as the task. Identify the task type (code review, document/design analysis, research/grounded answer, rewrite, or agentic/tool-heavy) and build the matching prompt from the `gpt-5-5-prompting` recipes, tailoring the sections to that type. Pull in any relevant absolute file paths from the conversation or repo.

## Output rules

- Output the finished prompt inside a single fenced ` ```text ` block so the user can copy it directly.
- Prose/context in the user's language; structural headers and technical directives in English (per the skill's output-language convention).
- Do NOT run Codex, do NOT call `/codex:review`, `/codex:rescue`, or `task` — this command only hands the user a prompt to paste.
- After the block, add one short line: "若 Codex 回應方向不對，告訴我哪裡偏掉，我再調 prompt。"

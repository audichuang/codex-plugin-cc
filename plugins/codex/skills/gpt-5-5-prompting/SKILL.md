---
name: gpt-5-5-prompting
description: Internal guidance for composing GPT-5.5 / Codex prompts for coding, review, diagnosis, research, and handoff tasks inside the Codex Claude Code plugin
user-invocable: false
---

# GPT-5.5 Prompting

Use this skill when composing a prompt for Codex / GPT-5.5 — both when `codex:codex-rescue` delegates a `task`, and when `/codex:handoff` produces a prompt for the user to paste into Codex.

GPT-5.5 works best with **outcome-first** prompts: define the target outcome, success criteria, constraints, and available context, then leave the model room to choose the path. Do not carry over process-heavy instruction stacks from older models — they add noise, narrow the search space, and produce mechanical answers.

## Core rules (from the official GPT-5.5 prompting guide)

- **Outcome-first, not process-first.** State the goal and what "done" looks like; don't script every step. Avoid "first inspect A, then B, then compare every field, then…".
- **Use `ALWAYS` / `NEVER` / `must` only for true invariants** — safety, required output fields, actions that must never happen. For judgment calls (when to search, ask, use a tool, keep iterating) write **decision rules** instead.
- **Always include stop rules.** GPT-5.5 will loop; tell it when to stop. Example: "After each result, ask: can I answer the user's core request now with cited evidence? If yes, answer."
- **Re-evaluate effort before escalating.** GPT-5.5 reasons more efficiently; prefer the lowest effort that meets the bar.
- **Give it a way to check its work** when validation is possible — targeted unit tests for changed behavior, type/lint checks, build checks, or a minimal smoke test. If validation can't run, say why and give the next best check.
- **Ground factual claims.** Define what needs support, what counts as enough evidence, and what to do when evidence is missing (absence of evidence is not a factual "no"). Add a retrieval budget for search-capable tasks.
- **Files: give absolute paths.** If the target can read files (Codex, Claude Code), list absolute paths and have it read them itself — never ask anyone to paste code.

## When to add what

- **Coding / debugging:** success criteria + a verification loop (tests/lint/build) + "ask only for the smallest missing high-risk detail."
- **Review / adversarial review:** grounding rules (cite `file:line`) + a structured, severity-ranked output contract + a "dig deeper / don't pad" nudge.
- **Research / recommendation:** a retrieval budget + citation rules.
- **Write-capable tasks:** a side-effect/safety constraint so Codex stays narrow and avoids unrelated refactors.
- **Conversational / agentic:** a short Personality + collaboration style, and a preamble for tool-heavy work.

## How to choose prompt shape

- Use the built-in `review` / `adversarial-review` commands when the job is reviewing local git changes — those prompts already carry the review contract.
- Use `task` when the task is diagnosis, planning, research, or implementation and you need to control the prompt directly.
- Use `task --resume-last` for a follow-up on the same Codex thread — send only the delta instruction unless the direction changed materially.

## Suggested structure

Keep each section short; add detail only where it changes behavior. Omit sections a task doesn't need.

```text
Role: [1-2 sentences: the model's function, context, and job]

# Personality        (conversational / agentic surfaces only)
# Goal               [the user-visible outcome]
# Success criteria   [what must be true before the final answer]
# Constraints        [policy, safety, evidence, and side-effect limits]
# Output             [sections, length, tone]
# Stop rules         [when to retry, fall back, abstain, ask, or stop]
```

## Output-language convention (for `/codex:handoff` and any user-facing prompt)

- Prose, narrative, and business context in the **user's language** (e.g. 繁體中文).
- Structural headers (`Role` / `Goal` / `Success criteria` / …), field names, and technical directives in **English** — GPT is most stable on English headers and it matches the official examples.
- Keep technical identifiers in their original form.
- Output the finished prompt inside a fenced ` ```text ` block so the user can copy-paste it directly into Codex / ChatGPT.

Reusable blocks live in [references/prompt-blocks.md](references/prompt-blocks.md).
Concrete end-to-end templates live in [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md).
Common failure modes to avoid live in [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md).

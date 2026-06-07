# Description-triggering eval set

`trigger-eval.json` — 20 queries (10 should-trigger Codex-runtime-behavior
questions, 10 near-miss should-not-trigger) used to optimize this skill's
`description` for triggering accuracy.

Re-run (skill-creator's loop, each query ×3, picks best by held-out test score):

```bash
SC="$HOME/.claude/plugins/cache/claude-plugins-official/skill-creator/.../skills/skill-creator"
cd "$SC" && python3 -m scripts.run_loop \
  --eval-set <repo>/.claude/skills/navigating-codex-source/evals/trigger-eval.json \
  --skill-path <repo>/.claude/skills/navigating-codex-source \
  --model <session-model-id> --max-iterations 5 --verbose
```

**Outcome (first run, 5 iterations):** the original description won (best test
5/8, recall 17%, precision 100%); no rewrite improved triggering. The skill
**under-triggers structurally**, not for wording reasons — a capable model judges
it can answer these Codex-behavior questions on its own (and the repo's CLAUDE.md
/ sibling skills / memory already point at `../codex`), so it rarely consults the
skill regardless of description. Treat this skill as an on-demand reference, not
something that reliably auto-fires.

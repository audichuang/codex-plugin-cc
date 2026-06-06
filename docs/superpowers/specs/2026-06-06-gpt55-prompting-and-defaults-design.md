# GPT-5.5 prompting skill + /codex:handoff + gpt-5.5/xhigh defaults

- 日期：2026-06-06
- 分支：`feat/gpt55-prompting`（基於 `main` = fork/main）
- 核可：使用者已逐項核可（Hybrid 範圍、`/codex:handoff`、裝成 plugin skill、完全取代 gpt-5-4-prompting、預設 model `gpt-5.5` / effort `xhigh`）。

## 目標

1. 用官方 GPT-5.5 prompting guide（`gpt5.5-prompting.md`）+ 使用者的 builder（`prompt.md`）建立新的內部方法論 skill `gpt-5-5-prompting`，**完全取代** `gpt-5-4-prompting`。
2. 新增 `/codex:handoff` 指令：把「反思這次工作 → 產一份給 Codex 審查的 GPT-5.5 prompt」變成一鍵，使用者複製貼到 Codex（**不自動跑 Codex**）。
3. 把 Codex 委派的**預設 model 改成 `gpt-5.5`、預設 reasoning effort 改成 `xhigh`**（保留 `--model`/`--effort` 與 env 覆寫）。

## 設計

### A. `gpt-5-5-prompting` skill（取代 `gpt-5-4-prompting`）
- `SKILL.md`（`user-invocable: false`）：蒸餾官方 guide 的可操作原則——outcome-first + success criteria、慎用 `ALWAYS/NEVER`（判斷類改 decision rule）、明確 stop rules、retrieval budget、personality/collaboration（對話型才用）、tool-heavy 加 preamble、check-your-work 驗證、creative-vs-source guardrail、建議結構 `Role / Personality / Goal / Success criteria / Constraints / Output / Stop rules`。
- `references/`：`gpt55-prompt-recipes.md`（code review / 文件分析 / 研究 / 改寫 / agentic 五個 template，源自 `prompt.md`）、`gpt55-prompt-antipatterns.md`、`prompt-blocks.md`。
- **刪除** `plugins/codex/skills/gpt-5-4-prompting/`。
- 更新引用 `gpt-5-4-prompting`→`gpt-5-5-prompting`：`agents/codex-rescue.md`、`skills/codex-cli-runtime/SKILL.md`、`README.md`、`tests/commands.test.mjs`。
- **不動** model id：`gpt-5.4-mini`、`gpt-5.3-codex-spark`、fake codex 預設 `gpt-5.4` 都保留（那是 model 名，不是 skill 名）。

### B. `/codex:handoff` 指令
- `plugins/codex/commands/handoff.md`，`allowed-tools: Read, Glob, Grep, Bash(git:*), Skill`。
- **空打**：用 `git diff`/`git log`/工作脈絡反思這次 session 做了什麼 → 載入 `gpt-5-5-prompting` skill → 產一份「請 Codex 審查這次工作」的 prompt，輸出在 ` ```text ` 區塊（絕對路徑、建議結構），讓使用者貼到 Codex。**不執行 Codex**。
- **帶參數**：把參數當任務，自動判類型（review/文件/研究/改寫/agentic），用同一方法論產 prompt。
- 結尾附「若 Codex 回應方向不對，告訴我哪裡偏掉」。

### C. 預設 model/effort
- `codex-companion.mjs`：`normalizeRequestedModel(null)` → `gpt-5.5`、`normalizeReasoningEffort(null)` → `xhigh`（取代原本回傳 `null`）。env 覆寫：`CODEX_DEFAULT_MODEL` / `CODEX_DEFAULT_EFFORT`（後者需驗證）。
- 確保 review 路徑的 model 也走 `normalizeRequestedModel`（若原本沒有則補）。
- 顯式 `--model` / `--effort` 與 alias（`spark`）行為不變。
- 更新文件：`README.md`（「if you do not pass --model/--effort, Codex chooses its own defaults」→ 改成「預設 gpt-5.5 / xhigh，可用 --model/--effort 覆寫」）、`agents/codex-rescue.md`、`skills/codex-cli-runtime/SKILL.md`（「Leave model/effort unset」相關描述）。
- 註：官方 guide 建議「先評估 low/medium 再升級」，xhigh 是使用者刻意選的最高品質取向，已知並接受。

## 測試（TDD）
- `runtime.test.mjs`：新增/調整「未給 --model/--effort → lastTurnStart.model=gpt-5.5、effort=xhigh」；顯式覆寫仍生效（既有 spark/low 測試不變）。
- `commands.test.mjs`：指令白名單加 `handoff.md`；handoff 內容斷言；`gpt-5-4-prompting`→`gpt-5-5-prompting` 引用斷言；model/effort 文件斷言改為新預設語意。
- 全套 `node --test` 綠。

## 不要做
- 不改任何真實 model id（gpt-5.4-mini / gpt-5.3-codex-spark / fake gpt-5.4）。
- `/codex:handoff` 不自動執行 Codex（只產 prompt 讓使用者貼）。

# delegate-plugin-cc 設計規格

日期：2026-06-11
狀態：設計已口頭核准（Telegram brainstorming），待使用者審閱本文件
參考：codex-plugin-cc（本 repo）、sakibsadmanshajib/antigravity-plugin 與 iicmaster/antigravity-plugins（lean spawn 移植模式）

## 1. 背景與目標

主 session 已經是最強的 Claude 模型，思考與規劃留在主 session。本 plugin 解決的唯一問題：
**把主 session 想清楚的執行型任務，委派給「便宜模型驅動的 headless Claude Code」去做，最省成本。**

關鍵賣點（codex/gemini 委派版做不到）：delegate 本身就是 Claude Code，
在同一個專案目錄下 spawn，因此使用者整套生態原生可用 —— CLAUDE.md、
skills、subagents、MCP servers、專案 hooks 全部繼承。settings profile
只蓋掉模型與 API 端點，其餘照舊。便宜模型拿著完整工具箱施工。

### 成功標準

- `/delegate:task "..." --profile kimi` 能在背景用 kimi 端點完成任務並回收結果。
- `/delegate:execute-plan docs/plan.md --profile glm` 能讓便宜模型照計畫實作。
- delegate 內部可正常觸發使用者的 skills 與 subagents。
- 新增一個模型 = 丟一個新 settings json 進 profiles 目錄，零程式碼改動。

## 2. 非目標（明確排除，之後可疊加）

- `review` / `adversarial-review`：便宜模型做 review 價值低，與定位矛盾。
- 一鍵 plan→execute pipeline（plan-profile + exec-profile 串接）：主 session 就是規劃者。
- broker / app-server 常駐層：`claude -p` 是一次性程序，不需要。
- 多引擎抽象（同時管 codex/gemini/agy）。
- handoff、attach、stop-review-gate hook。

## 3. 使用流程（典型）

1. 主 session（貴 Claude）與使用者討論、把任務想清楚（必要時寫成 plan 檔）。
2. `/delegate:task "<明確的執行指示>" --profile kimi --background`
   或 `/delegate:execute-plan docs/plan.md --profile glm --background`。
3. `/delegate:status` 看進度，`/delegate:result <job-id>` 取回輸出，主 session 驗收。
4. 要追問或修正：`/delegate:task --resume-last "<追加指示>"`（重用同一個 claude session）。

## 4. Profile 機制

- 一個 profile = 一份**標準 Claude Code settings.json**，放在
  `<CLAUDE_PLUGIN_DATA>/profiles/<name>.json`（例：`kimi.json`、`glm.json`）。
- 內容由使用者自管（`env` 區塊放 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`，
  `model` 指定模型等）。plugin 不定義自己的 schema、不碰 API key，
  只負責把 `--settings <該檔絕對路徑>` 傳給 `claude`。
- `--profile <name>` → 解析成上述路徑；`--settings <path>` 容許直接給任意路徑（escape hatch）。
- 未指定時用環境變數 `DELEGATE_DEFAULT_PROFILE` 指到的 profile；
  也沒有就報錯並列出可用 profiles（避免靜默用貴模型燒錢 —— 本 plugin 的存在意義就是省錢）。
- `setup` 指令驗證：claude CLI 存在、profiles 目錄裡每個 json 可解析、列出清單。

## 5. 架構

```
commands/*.md（薄殼） ──→ scripts/delegate-companion.mjs（CLI 入口）
                              │
                              ├─ lib/claude.mjs      spawn claude -p、stream-json 擷取、session id 記錄
                              ├─ lib/profiles.mjs    profile 解析與驗證
                              ├─ lib/state.mjs       job 狀態（沿用 codex-plugin-cc 驗證過的模式）
                              ├─ lib/job-control.mjs status/result/cancel
                              └─ lib/render.mjs      輸出渲染
```

### spawn 與輸出擷取

- 在**呼叫當下的專案目錄**spawn：
  `claude -p --settings <profile> --output-format stream-json --permission-mode bypassPermissions <prompt 經 stdin>`。
- prompt 走 stdin 而非 argv（iicmaster 的教訓：argv 會洩漏到 `ps`，且大 prompt 需處理 EPIPE —— 子程序提早退出時把寫入錯誤轉成 job failed，不讓 runner 崩潰）。
- stream-json 逐行解析進 `<job-id>.log`（含工具呼叫事件，供 status 顯示「最後活動」），
  最終 result 訊息與 `session_id` 寫進 per-job JSON。
- 解析容錯：非 JSON 行跳過不報錯（同 codex-plugin-cc 對 app-server stdout 的處理）。

### 背景任務狀態（直接沿用本 repo 模式，簡化）

- per-job JSON 檔為真相來源；`state.json` 只是衍生索引。
- 終態轉移走 O_EXCL `.lock` CAS（first-terminal-writer-wins）；寫檔 atomic（temp + rename）。
- pruning 永不淘汰 active job；上限 50 筆按 updatedAt 淘汰。
- timeout：**in-process 計時器**（SIGTERM → 寬限 → SIGKILL），不需要 detached
  watchdog —— delegate 是單一子程序，沒有 broker 那種「連線還在但卡死」的型態。
  死 PID reconcile（`process.kill(pid, 0)` 探活）沿用。
- 預設 timeout 1 小時（與 codex 版 1.0.18 對齊），`DELEGATE_JOB_TIMEOUT_MS` 可調。

### Resume

- 每個 job 記錄 stream-json init 訊息裡的 `session_id`。
- `task --resume-last` / `task --resume-id <job-id>`：用 `claude -p -r <session-id>`
  續接，新 job 以 `resumedFrom` 連回源 job，且必須沿用源 job 的 profile（不可中途換模型）。

## 6. 生態重用的邊界（寫清楚以免誤會）

| 項目 | delegate 內可用？ | 原因 |
|---|---|---|
| 專案 CLAUDE.md / .claude/rules | ✅ | 同 cwd 啟動 |
| 使用者與專案 skills | ✅ | 不在 settings.json 管轄內 |
| subagents（agents/） | ✅ | 同上；subagent 也跑在便宜模型上 |
| MCP servers（.mcp.json 等） | ✅ | 同 cwd；互動式認證的 server 在 headless 下可能缺席 |
| settings.json 各層 | ⚠️ 仍套用，但被 `--settings` profile 蓋掉重疊鍵 | CLI 旗標優先權最高 |
| 本 plugin 自己 | ❌ 故意停用 | 見防遞迴 |

## 7. 環境隔離（本設計最困難、最關鍵的部分）

主 session 的程序環境幾乎必然帶著自己的模型路由設定（`ANTHROPIC_BASE_URL`、
`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`、`CLAUDE_CODE_USE_BEDROCK`、各種
`CLAUDE_CODE_*`、`CLAUDECODE` 巢狀標記…）。子程序若直接繼承 `process.env`，
這些值可能蓋過或繞過 profile 的設定，使 delegate **實際上用主 session 的
端點與帳號執行** —— 省錢目的完全落空，而且可能觸發巢狀偵測的怪行為。

因此 spawn env 不靠繼承，按以下規則**重建**：

1. 複製 `process.env` 作為底。
2. **Denylist 剝除**所有 `ANTHROPIC_*`、`CLAUDE_*`、`CLAUDECODE*` 前綴變數
   （涵蓋 `CLAUDE_CODE_*`、`CLAUDE_PLUGIN_DATA`、`CLAUDE_ENV_FILE` 等主 session 注入的一切）。
   PATH、HOME、locale 等一般變數保留。
3. 解析 profile settings.json 的 `env` 區塊，**直接注入為真實程序環境變數**。
   這是 belt-and-suspenders：即使 Claude Code 的 settings-vs-ambient-env
   優先權語意未來改變，程序環境裡也只有 profile 的值，無歧義。
4. 注入 `CLAUDE_DELEGATE_ACTIVE=1`（防遞迴標記）。
5. `--settings <profile>` 照傳，涵蓋 env 以外的設定（model、permission 等）。

刻意**不**隔離的：`HOME` / `CLAUDE_CONFIG_DIR` 維持共用 —— 使用者層級的
skills、subagents 住在 `~/.claude`，隔離掉就違背「生態重用」的核心賣點。
此取捨明文記錄：共用 `~/.claude` 代表 delegate 與主 session 共用安裝的
plugins 與全域設定檔；模型路由的隔離完全由上述 env 重建保證。

驗收測試（hermetic）：在假裝被污染的環境下（`ANTHROPIC_BASE_URL` 指向貴端點、
`ANTHROPIC_MODEL` 設成 opus）呼叫 spawn 組裝函式，斷言產出的 env 不含污染值、
含 profile 注入值、含遞迴標記。

### 為什麼不用 tmux 隔離（評估過 claudecode-telegram 的做法後的裁定）

claudecode-telegram（bridge.py `create_session`）用 detached tmux session 起
互動式 Claude 實例，其隔離 = 「pane shell 從 tmux server 程序樹出生（不繼承
呼叫者執行期 env）」+「主動剝除 `CLAUDECODE`」+「主動注入需要的 env」——
本質與本節的 env 重建是同一招。tmux 對它是必需品（互動式 TUI、常駐、attach），
代價是 send-keys 競態、pane 讀回、trust-prompt 處理與大量 sleep。
本 plugin 的 delegate 是 headless 一次性 `claude -p`，stdout 直接擷取
stream-json，套 tmux 只會繼承那些痛點；且 tmux 新 shell 會重讀 rc 檔，
rc 裡的 `ANTHROPIC_*` 照樣進來，profile env 注入仍然省不掉。
故採 env 重建（一個 ~20 行純函式 + 單元測試），不引入 tmux 依賴。

## 8. 防遞迴

- spawn 時注入 `CLAUDE_DELEGATE_ACTIVE=1`。
- companion 入口與所有 hooks 開頭檢查此標記：是 → 立即 no-op 退出（指令印出說明文字）。
- 防止：便宜模型再往下委派造成無限鏈、或 delegate 內的 hooks 與外層搶 job 狀態。

## 9. 權限

- 預設 `--permission-mode bypassPermissions`（與 codex fork 硬編 danger-full-access
  同一哲學：隔離靠外層環境）。
- env `DELEGATE_PERMISSION_MODE` 可覆寫（例如改 `acceptEdits`）。

## 10. 錯誤處理

- claude CLI 不存在 → setup/task 給安裝指引。
- profile 不存在或 JSON 壞掉 → 列出可用 profiles，fail fast（spawn 前就擋）。
- 子程序非零退出 / stderr 含認證錯誤 → job failed，stderr 尾段進 result。
- timeout → SIGTERM + 寬限 SIGKILL，job 標 `timed-out`，提示 `--resume-id` 可續。
- stdin EPIPE → job failed（不崩 runner）。
- 第三方端點回傳非預期 stream 格式 → 容錯跳行；完全收不到 result 訊息時以 exit code 判定成敗、原始 log 留檔可查。

## 11. 測試策略

- TDD；hermetic seams 照搬本 repo（`tests/helpers.mjs` 模式：redirect
  `CLAUDE_PLUGIN_DATA`/`HOME`、清 ambient env、注入 spawnImpl/clock）。
- fake-claude fixture：可指令化地輸出 stream-json 腳本（正常完成、半路斷線、
  噴非 JSON 雜訊、卡住不動、立即退出）— 對應 codex 版的 fake-codex-fixture。
- 關鍵案例：**env 重建（污染剝除 + profile 注入，見 §7）**、profile 解析、
  stdin 大 prompt EPIPE、CAS 終態競爭、timeout 升級、resume 沿用 profile、
  遞迴標記 no-op、stream 雜訊容錯。

## 12. 風險與緩解

- **第三方 Anthropic 相容端點的工具呼叫品質參差** → 這是模型固有限制，不是 plugin 缺陷；
  result 渲染時附上 profile 名與模型名，方便使用者歸因。
- **stream-json 格式隨 Claude Code 版本演進** → 解析只依賴最小欄位集
  （type、session_id、result），其餘透傳進 log。
- **headless 下互動式 MCP 認證缺席** → setup 文件註明；不在 plugin 層解。

## 13. 命名（我的裁定，審閱時可改）

- repo：`delegate-plugin-cc`（新 repo，與 codex-plugin-cc 並列）。
- marketplace：`claude-delegate`；plugin：`delegate`；指令前綴 `/delegate:*`。

## 14. 開發順序（粗略，細節交給 writing-plans）

1. 骨架 + setup + profiles（含測試 seams 與 fake-claude fixture）
2. task 前景版（spawn、stream 擷取、result）
3. 背景化（state/CAS/timeout/status/result/cancel）
4. execute-plan、resume、防遞迴 hooks
5. 文件 + marketplace 上架

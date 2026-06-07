# Codex Plugin 可靠性缺口與借鑑實作計畫

> **這份文件的用途**：在另一個 session 接手實作。它是**自足的** —— 不需要前一個 session 的對話脈絡。
> 來源：用 20 個 agent 比對上游 `openai/codex-plugin-cc` 的 ~80 個 PR + 活躍 fork（dragon84867、Kagandi/pi），逐項對照本 fork 的實際程式碼，並對每個「缺口/部分」做對抗式覆核（避免誤報「我們沒有」）。所有 `file:line` 都已驗證。
> 產出日期：2026-06-07。母體上游最後更新停在 2026-04-18，本 fork 在核心 liveness 上**已領先上游**。

---

## 0. 給接手 session 的執行守則（硬性）

1. **TDD**：先寫測試（`tests/*.test.mjs`，`node --test`），再寫實作。Runtime lib 都保留可注入接縫（deps/options/spawnImpl/clientFactory），新測試請 `import` `tests/helpers.mjs` 以繼承隔離。
2. **測試必須 hermetic**：`tests/helpers.mjs` 會把 `CLAUDE_PLUGIN_DATA` 重導到暫存目錄並在載入時清掉 `CODEX_*`。**不要**讓新測試依賴 ambient env。
3. **任何 plugin 改動都要 bump 版本**：`node scripts/bump-version.mjs <x.y.z>`（同步 package.json / package-lock.json / plugin.json / marketplace.json）。否則 marketplace 快取（以版本為 key）會送舊副本，新行為不會生效。
4. **跨進程安全**：job 系統是多進程（worker / watchdog / cancel / session hook / reconcile）。任何新的 terminal 寫入都必須走 `applyJobPatchIfActive` / `claimTerminalTransition`，不可用裸 `writeJobFile`。
5. **不要無條件拆 broker**：broker 是 per-workspace 共享的。`broker/shutdown` 是 busy-gated，SessionEnd 在 broker busy 時跳過 teardown，watchdog 只 reap 確認 hung+unreachable 的 broker，`reapStaleBroker` 在 SIGKILL 前驗證進程身分。
6. 驗證指令：`npm test`、`node scripts/bump-version.mjs --check`、`npm run build`。

---

## 1. 架構速覽（`plugins/codex/`）

- `commands/*.md` — slash 指令（review, adversarial-review, rescue, execute-plan, handoff, status, result, cancel, setup）。薄包裝,轉發給 companion。
- `agents/codex-rescue.md` — rescue 子代理（薄轉發到 `task`）。
- `scripts/codex-companion.mjs` — CLI 入口：setup/review/task/status/result/cancel + 背景 job 編排。
- `scripts/lib/`：
  - `app-server.mjs` + `app-server-broker.mjs` + `broker-lifecycle.mjs` — per-workspace broker，講 Codex **app-server v2 JSON-RPC**。
  - `codex.mjs` — 組 thread/turn 參數、捕捉串流 turn（`captureTurn`）、渲染輸出。
  - `state.mjs` + `tracked-jobs.mjs` + `job-control.mjs` — 背景 job 狀態。**per-job JSON 檔是真相來源；`state.json` 是衍生索引**。terminal 轉換用 O_EXCL `.lock` CAS。
  - `codex-watchdog.mjs` + `liveness.mjs` — detached 活性看門狗（escalate-not-kill）。
  - `session-lifecycle-hook.mjs` + `stop-review-gate-hook.mjs` — SessionStart/End + stop-gate hook。

---

## 2. 已驗證的 Codex 行為事實（實作前必讀，源自閱讀 `../codex` 原始碼）

這些事實決定了下面缺口的修法為什麼正確：

- **`turn/start` 非阻塞**：立即回傳 `status: InProgress` 的 ACK（`app-server/src/request_processors/turn_processor.rs:467-478`），工作非同步串流。所以 per-RPC timeout 只 bound ACK，不會殺長 turn。
- **事件逐步串流**：turn 過程逐一發 `turn/started`、`item/started`、`item/completed`、`item/agentMessage/delta`、`turn/completed`。**沒有**叫 `agentMessage` 的方法;最終答案是 `item/completed` 帶 `AgentMessage` item。
- **Codex 自身沒有 app-server 層的 heartbeat / per-turn idle abort**。唯一較底層的兜底是 model-provider 的 `stream_idle_timeout`（預設 **5 分鐘**，×5 retry），只擋「卡在讀 model SSE」;卡在工具執行 / API 之間 / event loop 等其他狀態時**完全沒有伺服器端時限**。
- **client 斷線不會中止 running turn**：app-server 全 crate 唯一的 `Op::Interrupt` 在 `turn/interrupt` RPC 內,斷線路徑到不了。turn 跑在 app-server 進程內的 tokio task。**所以只殺 worker 或斷線停不掉 turn —— 必須 reap broker 進程。** 這就是 watchdog 設計要 reap broker 的根本原因。

---

## 3. 缺口清單（HIGH → MEDIUM → 設計決策）

> 狀態標記：`GAP` = 完全沒有；`PARTIAL` = 有部分/較弱版本；`DESIGN_DIVERGENCE` = 我們刻意相反。皆已對抗式覆核確認。

### 🔴 HIGH —— 真實會死掉 / 卡死 / 輸出爆掉

---

#### #1 captureTurn 缺 idle/heartbeat watchdog　【PARTIAL】　參考：上游 PR #302(part2)、#312

**問題**：我們只有一個 **15 分鐘固定硬上限**，不是「收到事件就重置」的心跳 timer。
- 後果一：一個長而**活躍串流**的 turn（持續吐 token 但超過 15 分鐘）會被硬砍。
- 後果二：真正**靜默卡死**的 turn（連線還在、但不再吐事件，例如卡在工具或 API 之間，見 §2 的事實）也要等滿整整 15 分鐘才被判定。
- 這正是「前景 rescue 傻傻等」的核心缺口：`exitPromise` race 只在**連線關閉**時才 fire（§2：斷線不停 turn,但連線可能就是不關），所以靜默+連線存活這種情況只能靠 15 分鐘硬上限慢慢等。

**真實症狀**（上游 repro）：app-server 回了 `turn/start` 之後停止發通知，`state.completion` 永不 resolve，socket 仍開著（無 exit），await 永遠掛住。

**我們的現況**：
- 固定硬上限：`plugins/codex/scripts/lib/tracked-jobs.mjs:204-214` arm 單一 `setTimeout(timeoutMs)`（`DEFAULT_JOB_TIMEOUT_MS` = 15min，`tracked-jobs.mjs:45`），在 `Promise.race` 對 `runner()`（`:217`）。沒有任何東西在通知到達時重置它。
- `captureTurn`（`plugins/codex/scripts/lib/codex.mjs:566-643`）只有 transport-close 的 `exitPromise` race（`codex.mjs:619-636`），grep `idle/heartbeat/lastActivity/resetTimer` = 0 命中。

**修法**：在 `captureTurn` 的通知處理裡加一個 idle timer：進入時 arm，每次 `applyTurnNotification` 重置，`finally` 清除。逾時則 reject 並帶上 thread/turn id（讓上層能 interrupt + reap）。建議可由 `CODEX_TURN_IDLE_TIMEOUT_MS` 設定（預設例如 5 分鐘，0 停用）。注意這是「無進展」timer，與 15 分鐘總上限互補,兩者都保留。

**測試**：注入假通知串流；(a) 持續通知 → 不逾時；(b) arm 後靜默超過 idle window → reject 帶 thread/turn id；(c) 正常 `turn/completed` → 清除 timer 不誤觸。

---

#### #2 stdout JSONL 解析太脆，一行垃圾就拆連線　【GAP】　參考：PR #311、#171

**問題**：`handleLine` 對任何非 JSON / 帶 ANSI escape 的行,`JSON.parse` 失敗就呼叫 `handleExit(createProtocolError(...))` **拆掉整條連線** → turn 死掉。這是「穩定輸出不死掉」的核心。Codex CLI 偶爾會在 stdout 混入非 JSONL 內容或 ANSI 序列。

**我們的現況**：
- `plugins/codex/scripts/lib/app-server.mjs:156-167`：`:157` 只跳過空白行，`:163` 對原始行 `JSON.parse`，catch（`:165`）直接 `handleExit`。無首字 `{`/`[` 防護、無 strip ANSI。
- broker 的 reader 同樣：`plugins/codex/scripts/app-server-broker.mjs:148` 也直接 `JSON.parse` 原始行。
- 無 `lib/strings.mjs` / `stripAnsi` / `cleanProtocolLine`（grep 全 scripts/ = 0）。

**修法**：
1. 新增 `lib/strings.mjs` 的 `stripAnsi`（CSI + OSC regex,採 #311 較廣的 ECMA-48 grammar，能處理 `200~`/`201~` bracketed-paste,勝過 #171 只認 `[a-zA-Z]` 結尾）。
2. 在兩處解析前先 `stripAnsi` + `trim`,若首個非空白字元不是 `{` 或 `[` 就**跳過該行**（不 fatal）。
3. 保留 `handleExit` 只給「看起來像 JSON 卻 parse 失敗」的行。

**測試**：餵 (a) 純垃圾行 → 跳過不拆連線；(b) ANSI 包裹的合法 JSON → strip 後成功 parse；(c) 真正壞掉的 JSON-like 行 → 仍走 handleExit。兩個解析點各測一次。

---

#### #3 app-server 子進程組沒被收乾淨（孤兒 MCP 子進程）　【GAP】　參考：PR #358

**問題**：spawn `codex app-server` 時**沒有 detached**,close() 在 POSIX 用裸 `SIGTERM`(非 `terminateProcessTree`)。app-server 會 spawn 自己的 MCP / 工具子進程;只 SIGTERM 父進程會留下孤兒子樹。

**我們的現況**：
- `plugins/codex/scripts/lib/app-server.mjs:234` spawn 時只設 stdio/shell/windowsHide,**無 `detached`**。
- close()（`app-server.mjs:285-303`）把 `terminateProcessTree` 鎖在 `process.platform === 'win32'` 之後,POSIX 走裸 `this.proc.kill('SIGTERM')`（`:300`）。

**修法**（照 #358）：
1. `CodexAppServerClientOptions` 加 `detachProcessGroup`。
2. spawn（`app-server.mjs:234`）設 `detached: process.platform !== 'win32' && this.options.detachProcessGroup === true`,讓它領自己的進程組。
3. broker（`app-server-broker.mjs`）傳 `detachProcessGroup: true`（它已裝 SIGINT/SIGTERM handler）。
4. close() 一律走 `terminateProcessTree`(用 `kill(-pid)` 群組訊號收整棵樹),不再只在 win32 才用。

**測試**：用 spawn 接縫驗證 detached flag 在 POSIX 為 true;close() 在 POSIX 也呼叫 `terminateProcessTree`。注意保留 §0.5 的 broker 共享安全。

---

#### #4 adversarial-review prompt 無大小上限，撞 API 1MB 硬失敗　【GAP】　參考：PR #314（勝過 #313），相關 #327

**問題**：`buildAdversarialReviewPrompt` 原樣插入內容,self-collect 分支本身無界。大 diff / 大量 untracked 檔會讓 rendered prompt 撞 **Codex API 1MB 輸入硬上限**直接失敗。

**我們的現況**：
- `plugins/codex/scripts/codex-companion.mjs:266-275`,`REVIEW_INPUT`（`:273`）verbatim 插入,無 byte/char cap,無截斷,無 UTF-8 邊界處理。
- grep `1048576` / `1024*1024` / `byteLength` / `truncat` / `MAX_PROMPT` 全 prompt 路徑 = 0。
- 現有的 256KB raw-diff gate(`git.mjs:8-9` `DEFAULT_INLINE_DIFF_MAX_FILES=2`、`DEFAULT_INLINE_DIFF_MAX_BYTES=256*1024`)只擋 inline diff,**沒擋 self-collect 分支**。

**修法**（照 #314）：在 `buildAdversarialReviewPrompt` 對**最終 rendered prompt** 加 backstop：
1. 先試完整 prompt;
2. 超過上限（~800KB)則 fallback 到輕量摘要(summary + 前 50 個變更檔);
3. 仍超過則 `truncateToByteBudget`,在 UTF-8 continuation byte(`0xc0`/`0x80`)邊界截斷 + 截斷提示,**絕不切斷多位元組序列**。

**注意順序**：若日後採 #327 把 inline 預設提高到 1MB,**必須**先有這個 final-prompt cap,否則 inline 路徑也會撞牆。

**測試**：餵超大內容 → 確認最終 bytes ≤ 上限且為合法 UTF-8（不破壞多位元組字元）、有截斷提示。

---

#### #5 hook stdin 不處理 EAGAIN，pipe 抖動就崩潰　【GAP】　參考：PR #165（#189 的超集）

**問題**：兩個 hook 都用單次 `fs.readFileSync(0)` 讀 stdin,無 try/catch。非阻塞 pipe 上的 `EAGAIN` 會 throw → hook 崩潰,丟掉 `session_id`、讓 SessionStart/End 與 broker 生命週期失準。

**我們的現況**：
- `plugins/codex/scripts/session-lifecycle-hook.mjs:30-36` `readHookInput()`:`const raw = fs.readFileSync(0, "utf8").trim()`,無 try/catch。
- `plugins/codex/scripts/stop-review-gate-hook.mjs:21-27` 相同。
- 全 scripts/（含 hooks + lib）grep `EAGAIN|EWOULDBLOCK|readSync|Atomics.wait` = 0。

**修法**（照 #165）：抽一個共用 helper（避免兩份 `readHookInput` 漂移），用 chunked `fs.readSync` 迴圈累積 chunk,遇 `EAGAIN`/`EWOULDBLOCK` 做 bounded retry(Atomics.wait backoff),解析失敗或無輸入回 `{}`。

**測試**：模擬一個先丟一次 EAGAIN 再給資料的 pipe → 應成功讀到完整 payload；空 pipe → 回 `{}` 不 throw。

---

#### #6 跨 workspace 找不到 job　【GAP】　參考：dragon84867 fork（`collectCandidateStateRoots` + `findJobByIdAcrossWorkspaces`）

**問題**：`status` / `result` / `cancel` 只查當前 workspace 的 state。把在 workspace A 拿到的 job id 拿到 workspace B 的指令裡查 → 「Job not found」。

**我們的現況**：
- `plugins/codex/scripts/lib/job-control.mjs:335-339` `resolveCancelableJob` 只 `listJobs(resolveWorkspaceRoot(cwd))`。
- `plugins/codex/scripts/codex-companion.mjs:950` status 也只 `listJobs(workspaceRoot)`。
- `resolveStateDir`（`state.mjs:56-71`）只 derive 單一 per-workspace state dir,從不列舉 sibling workspace。
- grep `AcrossWorkspaces|AcrossRoots|collectWorkspace|candidateStateRoots|findJobById` = 0。

**修法**：加 `collectCandidateStateRoots`（current root + HOME-anchored 穩定 fallback + 舊 `$TMPDIR` + 所有 `~/.claude/plugins/data/codex-*/state`）與 `findJobByIdAcrossWorkspaces`,**僅在「使用者明確給 job-id 卻在當前 workspace 找不到」時**當 fallback。預設(無 id)的選擇仍維持 session/workspace scope,避免跨 workspace 誤選。

**測試**：在兩個假 state root 各放一個 job,從其中一個 root 用另一個的 id 查 → fallback 找得到；無 id 的列表仍只回當前 workspace。

---

#### #7 背景 job 是黑盒，只能 poll（直接對應「rescue 傻傻等」痛點）　【PARTIAL】　參考：PR #291 `/codex:attach`；可選 dragon `.events.jsonl`

**問題**：`/codex:rescue --background` 後只能用 `/codex:status` 一行式輪詢,看不到 Codex 正在做什麼,直到完成。

**我們的現況**：
- 基礎已有：`plugins/codex/scripts/lib/tracked-jobs.mjs:92` `appendLogLine` 寫時間戳行到 `job.logFile`;`plugins/codex/scripts/lib/job-control.mjs:75` `readJobProgressPreview` 回最後 N 行。
- 但只有 snapshot/poll,沒有 live tail。

**修法**：加薄 `/codex:attach`（或擴充 `/codex:status --follow`）：resolve job（by id,或用 `sortJobsNewestFirst` + `isActiveJobStatus` 取最新 active,如 `resolveCancelableJob` 既有做法）→ 從 byte offset 迴圈讀 `job.logFile` 只輸出新位元組 → job 到 terminal status 時乾淨退出。
- 可選加值：dragon 的 per-job `<job>.events.jsonl` 結構化事件流（typed: phase / tool_call / command / file_change / message / completed）。我們已 normalize progress event（`tracked-jobs.mjs` `normalizeProgressEvent`），持久化成 sibling jsonl 是增量改動,能解鎖更豐富的 attach 渲染與機器消費者。

**測試**：寫入 log 行 + 模擬 job 終態 → attach 輸出新行且在終態退出（用注入的 clock/poll-interval 做確定性測試）。

---

### 🟡 MEDIUM —— 值得補，非救命

| 項目 | 狀態 | 現況證據 | 修法 / 參考 |
|------|------|---------|------------|
| Broker PID 探活前置門 | PARTIAL | `broker-lifecycle.mjs:230` reuse 只靠 150ms socket ping（`:145-154`），crash 但 socket 還活的 broker 會被沿用 | 加 `isSessionStale(session)` 檢 `session.pid != null && !isProcessAlive(session.pid)`,AND 進 reuse 條件。PR #262 |
| 登入切帳號後的 stale broker | GAP | `app-server.mjs:377-393` connect() 無 post-initialize 帳號驗證 | 加 `accountFingerprint`（`account/read`）比對,不符就替換 broker session;加 `resolveLiveBrokerEndpoint` 忽略死 endpoint。PR #303 |
| main() 失敗無 stdout 錯誤封包 | GAP | `codex-companion.mjs:1112-1117` catch 只寫 stderr,exitCode=1 | rescue agent 只抓 stdout → 失敗對它隱形。catch 也寫 `{status:'error',error,exitCode:1}` JSON 到 stdout;更新 `agents/codex-rescue.md` 回報 error 欄。PR #360 |
| 永久 auth 錯誤不短路 | GAP | `codex.mjs:544-546` `error` case 只記錄不 `completeTurn` | 401/403/Missing bearer/invalid api key 命中窄 regex 就 `completeTurn(failed)`;regex 要窄,別誤殺 429/5xx。PR #294 |
| 背景完成 sentinel + `--await` | PARTIAL | 有 `.done` signal（`codex-companion.mjs:723-734`）+ `status --wait`（`:905-916`,`waitForSingleJobSnapshot :343-356`）,但缺機器可讀 sentinel 行與 `--await` | 加 `[[codex-task status=dispatched id=...]]` 哨符行到 `renderQueuedTaskLaunch`;可選 `task --background --await`（複用 `waitForSingleJobSnapshot` block 到終態）。PR #346/#347 |
| `--base` ref 驗證 | GAP | `git.mjs:142-149` 對顯式 baseRef 直接回傳,無 `rev-parse --verify` | 回傳前跑 `git rev-parse --verify --quiet <ref>^{commit}`,非零給 typo/fetch 提示。PR #294 |
| `clientInfo.name` 命名空間化 | GAP | `app-server.mjs:28` name 仍 `"Claude Code"`（title 已 `"Codex Plugin"`） | 改 `DEFAULT_CLIENT_INFO.name` 為 `codex_claude_code`;讓 fake fixture 記 `lastInitialize` 並加測試。PR #200/#255 |
| sandbox `inherit` 模式 | PARTIAL | `codex.mjs:63-66` `resolveSandboxMode` 永遠回具體 mode,從不 null | 加 `inherit` sentinel:回 null 時 `buildThreadParams`/`buildResumeParams` 省略 sandbox 鍵,讓 Codex 用自己的 config。PR #241 |
| `CODEX_PLUGIN_DATA` env 命名 | GAP | `session-lifecycle-hook.mjs:109` 寫 `export CLAUDE_PLUGIN_DATA=`;`state.mjs:68` 只讀 `CLAUDE_PLUGIN_DATA` | 改 export `CODEX_PLUGIN_DATA`,`resolveStateDir` 讀 `CODEX_PLUGIN_DATA \|\| CLAUDE_PLUGIN_DATA`。**注意**:測試套件用 `CLAUDE_PLUGIN_DATA` 做隔離(見 CLAUDE.md),改動要保持向後相容。PR #339 |
| Windows broker spawn 用 cmd.exe | GAP | `app-server.mjs:238` 仍 `shell: win32 ? (SHELL\|\|true) : false` | broker spawn 改 `shell: win32 ? 'cmd.exe' : false`(解 PATHEXT 的 codex.cmd,避開 Git Bash MSYS 路徑翻譯)。注意這與 `process.mjs` 的 shell:false 是不同選擇,需在註解說明 broker spawn 為何能安全用 cmd.exe（固定 argv）。PR #294 |
| taskkill 別靠英文字串 | PARTIAL | `process.mjs:67-68` `looksLikeMissingProcessMessage` 是英文 regex | 改用 taskkill exit code（128 = not found）判斷,別依賴 localized stderr。我們已 `shell:false` 規避了 MSYS 那半。PR #220 |

### ⚖️ 設計決策（需你拍板，非單純缺口）

#### SessionEnd 殺背景 job　【DESIGN_DIVERGENCE】　參考：PR #355

**現況**：`plugins/codex/scripts/session-lifecycle-hook.mjs:69-95` `cleanupSessionJobs` **無條件**對所有 session job `terminateProcessTree` + 標 failed,`:103` 從 state prune。沒有 `job.background` 豁免。

**張力**：對前景/互動 job 這是對的;但對 `--background`（設計上應「outlive session」）特別是 **subagent 派發的 `--background` rescue**(subagent turn 結束 ≈ SessionEnd → 把剛 detach 的 worker 砍掉)是真實 hazard。上游 #355 的 repro：subagent dispatch `codex-rescue --background` → turn end → SessionEnd hook 殺掉 detached worker → transcript 凍在 SIGTERM,父 session 後續 `/codex:status` 查無。

**建議方向**：給 `enqueueBackgroundTask` 的記錄打 `background: true`;`cleanupSessionJobs` 跳過 `background` job;broker 還有 active 背景 job 時 SessionEnd 不拆。**請先決定本 fork 是否要支援「背景 job 跨 session 存活」這個語意**,再實作。

---

## 4. 明確「不要採用」（別重蹈別人覆轍）

- **PR #214**（rescue 強制前景）：上游已被 #246/#347 取代 —— subagent 前景會在 ~143s 被 Claude Code 砍。**不要採**。
- **PR #162**（Windows `shell:true` 給 PATH-resolved CLI）：注入風險(`git --base` ref / 檔案路徑是使用者可控)。保留 `process.mjs:26` 的 `shell:false` + 延後的 `.cmd` cmd.exe-wrapper 計畫。**不要採 shell:true**。
- **PR #360 的「全 Windows 強制 danger-full-access」**：靜默關掉 sandbox 是安全倒退。本 fork 的 `CODEX_SANDBOX_MODE=danger-full-access` 顯式逃生艙更好（見 CLAUDE.md）。**不要採全平台 coercion**（但 #360 的 stdout 錯誤封包要採,見 MEDIUM）。
- **PR #343 的全域 state lock**：保留本 fork 的 per-job 檔（authoritative）+ O_EXCL CAS 設計;workspace 級 lock 比模型需要的重。只有出現實際 lost-index-update 症狀才重議。

---

## 5. 建議實作順序

1. **第一批（最防死、改動小、純後端可測）**：#2 stdout 解析健壯化 → #5 hook EAGAIN → #1 captureTurn idle heartbeat。
2. **第二批（進程/連線生命週期）**：#3 進程組 reaping → MEDIUM 的 broker PID 探活 + stale-account。
3. **第三批（輸出與失敗可見性）**：#4 prompt size cap → MEDIUM 的 main() stdout 錯誤封包 + 永久 auth 短路。
4. **第四批（UX/可觀測性）**：#7 `/codex:attach` → #6 跨 workspace 查找 → 背景 sentinel/`--await`。
5. **設計決策**：SessionEnd 背景 job 存活（先拍板）。
6. 每完成一批：`npm test` 綠 → `node scripts/bump-version.mjs <new>` → commit。

---

## 6. 對照表：上游 PR / fork → 本 fork 狀態

| 來源 | 主題 | 本 fork 狀態 |
|------|------|------------|
| #261, #243, #184, #302(part1), #267, #225, #176 | hang/zombie 核心 | ✅ ALREADY_HAVE（已領先上游） |
| #302(part2), #312 | captureTurn idle heartbeat | ⚠️ PARTIAL → 缺口 #1 |
| #311, #171 | stdout 解析健壯 | ❌ GAP → 缺口 #2 |
| #358 | 進程組 reaping | ❌ GAP → 缺口 #3 |
| #313, #314, #327 | prompt size cap | ❌ GAP → 缺口 #4 |
| #189, #165 | hook EAGAIN | ❌ GAP → 缺口 #5 |
| dragon fork | 跨 workspace 查找 | ❌ GAP → 缺口 #6 |
| #291, dragon `/codex:observe` | live attach | ⚠️ PARTIAL → 缺口 #7 |
| #262, #303, #360, #294, #346, #347, #200, #255, #241, #339, #220 | 見 MEDIUM 表 | 部分/缺口 |
| #355 | 背景 job 跨 SessionEnd 存活 | ⚖️ 設計決策 |
| #214, #162, #360(coercion), #343 | — | 🚫 不要採用 |

---

*本文件由可靠性比對分析產出。實作前請重讀 §0 守則與 §2 行為事實。每個缺口的 `file:line` 對應產出當下的程式碼,實作時請以當前原始碼為準（若已變動,先確認該 symbol/行仍存在）。*

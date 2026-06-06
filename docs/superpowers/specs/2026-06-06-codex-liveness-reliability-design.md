# Codex Plugin — Liveness + Reliability 補完設計

- 日期：2026-06-06
- 分支：`feat/liveness-5min`（基於 `fork/main` = `audichuang/codex-plugin-cc`，領先 `openai/codex-plugin-cc` 7 個 commit）
- 目標：讓 plugin 能**可靠地調用 Codex**（消除「結果回不來」的永久 hang），並新增**每 ~5 分鐘的主動 liveness 檢查**。Prompt 行為不變。

## 背景：問題與既有修法

20-agent 調查（對「未含 fork 修法的上游」執行）確認「結果回不來」的真正根因：

1. `captureTurn` 結尾 `await state.completion`（`lib/codex.mjs`）沒有 timeout，`rejectCompletion` 全 `scripts/` 零呼叫點 → 唯一的 `turn/completed` notification 沒到就永久 hang。
2. 上游死亡不傳播：`handleExit`（`lib/app-server.mjs`）只 reject pending requests，碰不到 `state.completion`。
3. 唯一 fallback（inferred-completion timer）要 `phase === 'final_answer'`，但 Codex 的 `phase` 是 `Option` 常為 `None` → fallback 自我失效。
4. 背景 job 完成寫進磁碟卻被禁止 surface；worker 死掉時 job 永遠停在 `running`。
5. （已推翻）broker 丟 completion notification — 對抗驗證證明因果不成立，**不要**為此加 buffer。

**fork 已完成**（base 已有，務必保留）：
- `d3bdcc2` `captureTurn` transport watchdog（race `client.exitPromise`）→ 治根因 #2。
- `d3bdcc2` `runTrackedJob` 15 分鐘 hard timeout（`CODEX_JOB_TIMEOUT_MS`，Layer 2）→ 治根因 #1。
- `e017df5`/`7e4eefc` dead-PID reconcile（Layer 3）→ 治根因 #4 一半。
- `42ed4e3`/`1ba684a` CAS 狀態序列化（`applyJobPatchIfActive`）→ 治狀態競態。
- `8cf4765` idle log 狀態揭露。
- `eee2766` `/codex:execute-plan` 自動化指令。

**基線測試**：除 `tests/commands.test.mjs:73` 一個紅燈（`execute-plan.md` 未加入指令白名單斷言）外全綠。

## 缺口（本次範圍 G1–G5）

| # | 缺口 | 對應根因/需求 |
|---|------|------|
| G0 | `commands.test.mjs` 紅燈未修 | 測試綠燈 |
| G1 | 無主動 5 分鐘 liveness 探測（只有被動 15 分鐘 hard timeout） | 使用者明確需求 |
| G2 | timeout/卡死只標 failed，不取消 turn、不殺 process tree → orphan 進程 | 根因 #1/#2 收尾 |
| G3 | broker 未硬化：無 idle-exit、未殺 stale broker、未記錄 codex 孫程序 pid | broker 堆積會造成日後 no-reply；殺不到最深進程 |
| G4 | 背景結果不自動回拋（要手動 `/codex:status`） | 根因 #4 另一半 |
| G5 | protocol-drift 對齊、`request()` per-call timeout、inferred-completion 在 `phase` 缺失時強化、SessionEnd 寫終結狀態 | 邊角硬化 |

## 設計

### 防禦分層（最終狀態）

```
Layer 0  request() per-call timeout           (G5) — broker 接受 socket 卻不回應時快速失敗
Layer 1  captureTurn transport watchdog       (既有) — transport 死亡即 reject
Layer 2  runTrackedJob hard timeout 15m       (既有 + G2) — 到期改成 interrupt→kill→fail，而非只標記
Layer 3  dead-PID reconcile on read           (既有) — /codex:status|result 時就地翻 failed
Layer 4  codex-watchdog.mjs 每 5 分鐘主動探測   (G1) — 背景 job 的獨立觀察者，卡死即 interrupt→kill→fail→.done
Layer 5  broker idle-exit + 殺 stale broker    (G3) — 杜絕 orphan broker 累積
```

### G1 — 5 分鐘 liveness watchdog（Hybrid：detached 引擎 + Monitor 輔助）

**引擎**：新增 `plugins/codex/scripts/codex-watchdog.mjs`。在 `enqueueBackgroundTask`（`codex-companion.mjs`）spawn 背景 worker 的同時，以 `detached:true, stdio:"ignore", unref()` 一起 spawn 一個 watchdog，參數帶 `cwd / jobId`。

每個 tick（`CODEX_WATCHDOG_INTERVAL_MS`，預設 `300000`）：
1. 讀 job file；status 已終結 → watchdog 自行退出。
2. `workerAlive = process.kill(pid, 0)` 不丟 `ESRCH`。
3. `quietMs = now - stat(logFile).mtimeMs`（用 log mtime，不用 `updatedAt`，因 same-phase 長工作 `updatedAt` 會凍結）。
4. `brokerOK = waitForBrokerEndpoint(endpoint, ~300ms)`（合成可達性探測；連 `-32001 BUSY` 都算活著）。
5. 分類：
   - `DEAD` = `!workerAlive`
   - `HUNG` = `workerAlive && quietMs > HANG_QUIET_MS(900000) && !brokerOK` **或** `quietMs > HARD_QUIET_MS(1800000)`
   - `HEALTHY` = 其他 → 睡到下一 tick
6. `DEAD`/`HUNG` → **grace re-check（~10s）後重驗一次**，仍判定才動手：`interruptAppServerTurn(cwd,{threadId,turnId})` → `terminateProcessTree(pid)` → 寫 `failed` + `writeCompletionSignalFile`（帶清楚 `errorMessage` 與 `resume` 提示）。

分類器抽成**純函式** `classifyLiveness({workerAlive, quietMs, brokerOK, thresholds})` 以利 TDD；I/O（`process.kill`、`stat`、probe）以可注入 deps 傳入。

**輔助（Monitor）**：`rescue.md` / `execute-plan.md` / `status.md` 文件化 in-session 監督模式：`until [ -f signalFile ]; do sleep 2; done` + 完成時 `PushNotification`。引擎與 Monitor 收斂到同一個 `.done` signal。

**避免誤殺慢但正常的 turn**：以事件靜默時間為準（非 wall-clock 總長）；一般 `HUNG` 需「長靜默 AND broker 不可達」雙條件；kill 前 grace 重驗；門檻全 env 可調；observational-first（先在 `/codex:status` 顯示 suspect，再升級，最後才動手）。

### G2 — 卡死時取消 + 殺乾淨

- `runTrackedJob`（`tracked-jobs.mjs`）Layer-2 timeout 觸發時，在 reject 前先嘗試 `interruptAppServerTurn` + `terminateProcessTree`（重用 `codex-companion.mjs` `handleCancel` 的序列），不再只是標記 failed 留 orphan。
- 需要 G3 的孫程序 pid 才能殺到最深進程。

### G3 — broker 硬化

- `app-server-broker.mjs`：加 `IDLE_TIMEOUT_MS`（預設 `5000`）+ `startIdleTimer`/`cancelIdleTimer`，最後一個 client socket 關閉後自動退出；把 codex app-server **孫程序 pid** 記入 `broker.json`。
- `broker-lifecycle.mjs`：`ensureBrokerSession` 的 `killProcess` 預設 `?? terminateProcessTree`；持久化孫程序 pid，供 watchdog/cancel 殺到最深。

### G4 — 背景結果自動回拋

- `state.mjs`：新增 `writeCompletionSignalFile(workspaceRoot, jobId, {status, reason})` 寫 `<jobId>.done`；`resolveJobDoneFile`；prune job 時一併清 `.done`。
- `tracked-jobs.mjs`：`runTrackedJob` 成功與失敗兩分支都呼叫 `writeCompletionSignalFile`。
- `codex-companion.mjs`：`enqueueBackgroundTask` 在印給 stdout 的 launch payload 帶 `jobsDir` + `signalFile`。
- `rescue.md` / `execute-plan.md`：`--background` 時指示主執行緒 Monitor `signalFile` 並在完成時 `PushNotification`（取代「禁止 poll」）。

### G5 — 邊角硬化

- `app-server.mjs`：`DEFAULT_CAPABILITIES` 加 `requestAttestation:false`；若仍有 `experimentalRawEvents:false` 於 `buildThreadParams` 則移除（對齊現行 Codex 協定）。`request()` 加 optional per-call timeout。
- `codex.mjs` `scheduleInferredCompletion`：`exitedReviewMode`/review output 與任何 tracked thread 的 final answer 都當完成訊號；`phase` 缺失不卡死；加一個更長的絕對 fallback timer。
- `session-lifecycle-hook.mjs`：session 結束 terminate running job 時寫 `failed` + `.done`（reason: session ended），避免被 prune 後消失。

## 測試策略（TDD，`node --test tests/*.test.mjs`）

- `tests/codex-watchdog.test.mjs`（新）：`classifyLiveness` 的 DEAD/HUNG/HEALTHY/雙條件邊界、grace 重驗、escalate-not-kill、signal 寫入。
- `tests/state.test.mjs`（擴）：`writeCompletionSignalFile`/`resolveJobDoneFile`/prune 清 `.done`。
- `tests/tracked-jobs.test.mjs`（擴）：timeout 觸發 interrupt+kill+`.done`；成功/失敗都寫 `.done`。
- broker/app-server 測試（擴/新）：idle-exit、孫程序 pid 記錄、`request()` timeout、`DEFAULT_CAPABILITIES`。
- `tests/commands.test.mjs`（修 G0）：白名單加 `execute-plan.md`。
- `tests/codex.test.mjs`（如有/新）：inferred-completion 在 `phase` 缺失時仍完成。
- session-lifecycle 測試：寫 failed + `.done`。

I/O 邊界（`process.kill`、`fs.stat`、probe、`spawn`）一律以可注入 deps 設計，確保純邏輯可單測。

## Env 旋鈕

| 變數 | 預設 | 用途 |
|---|---|---|
| `CODEX_WATCHDOG_INTERVAL_MS` | `300000` | watchdog tick 間隔（5 分鐘）|
| `CODEX_WATCHDOG_HANG_QUIET_MS` | `900000` | HUNG 的靜默門檻；**僅在 broker 同時不可達時**才判 HUNG（靜默本身不致命）|
| `CODEX_JOB_TIMEOUT_MS` | `900000` | （既有）Layer-2 hard timeout（hung-but-alive 的主責層）|
| `CODEX_REQUEST_TIMEOUT_MS` | `120000` | Layer-0 per-call RPC timeout（0 停用）|
| `CODEX_BROKER_IDLE_TIMEOUT_MS` | `5000` | broker 無 client 後自動退出 |

> **Code review 後修正（BLOCKER 1）**：移除原本「僅憑靜默超過 `HARD_QUIET_MS` 即殺」的分支。理由：broker 是獨立進程，codex 卡死時 broker 仍可達，故「靜默 + broker 可達」無法區分卡死與慢但正常；且 hung-but-alive 已由 worker 自身的 Layer-2 hard timeout 兜底。watchdog 因此只在 `DEAD`（worker 不在）或 `靜默 + broker 不可達` 才動手，徹底避免誤殺。

## 交付與後續

1. 在 `feat/liveness-5min` 上以 TDD 完成 G0–G5，`node --test` 全綠。
2. 依使用者工作流：完成後用既有 GPT-5.5 Prompt Builder（prompt 不改）產一份**給 Codex 審查本次實作**的提示詞。

## 實作偏差（誠實記錄）

實作時對 Codex 原始碼查證後，對 G5 兩個原計畫項目做了調整：

- **跳過 protocol-drift（加 `requestAttestation:false` / 移除 `experimental_raw_events`）**：在 `codex-rs/app-server-protocol/src/protocol/v1.rs` 與 `v2/thread.rs` 確認這兩個欄位都標了 `#[serde(default)]`，server 端省略即反序列化為 `false`。所以本 repo 省略它們**本來就等同送 false**，補上是 no-op、不是漂移修復；亂加反而多餘，故不動。
- **跳過 inferred-completion 在 `phase` 缺失時的強化**：那是次要 fallback，主完成路徑 `turn/completed`（Codex 對中止/失敗也會發）正常運作，且已被三層（transport watchdog / 15m hard timeout / 5m watchdog）兜底。改 `captureTurn` 狀態機風險高、邊際價值低，故維持現狀。

其餘 G0–G4 與 G5 的 request() timeout、session-end surfacing 全數依設計完成，全程 TDD。

### Code review 後第二輪複驗（8-agent workflow）的強化

對抗式複驗確認 6 個 review 修正全部成立、測試 meaningful，並額外發現並修正：

- **補回 BLOCKER 1 移除 hard-ceiling 後的殘留 gap**：watchdog 改用 job 自身的 `timeoutAt` 偵測「worker 過了自己宣告的 deadline 仍未自我了結」（event-loop 卡死的情況），`gatherObservation` 算 `missedOwnDeadline`（過期 + 60s grace），`classifyLiveness` 據此判 HUNG。因為以 job 自己的 deadline 為界，**絕不誤殺仍在預算內工作的 turn**，同時封住「卡死但 broker 可達」對所有層都漏接的洞。
- **success-path 反向 race guard**：`runTrackedJob` 成功分支寫終結記錄前先檢查 job 是否已被外部（watchdog/reconcile）標為 terminal；若是則不覆寫、不寫 completed signal（first-terminal-writer-wins），仍回傳 execution。

明確記錄、暫不處理（低機率、且屬既有架構）：
- **cancel path TOCTOU**：`handleCancel` 選取已過濾 active，但選取到寫入間若 job 轉 terminal，'cancelled' 可能覆寫真正終結態。非-CAS 終結寫入為既有行為；難寫出決定性測試，依「不加未測程式碼」原則暫記為已知低機率 race。
- **`.done` 非原子寫入（torn read）**：payload 目前不被讀取（monitor 只看存在性、`/codex:result` 讀權威 per-job JSON），YAGNI 暫不加 tmp+rename。

最終 `node --test` 165 passing。

## 明確不要做

- 不要為「no-reply」給 broker 加 notification buffer/ack/retry（對抗驗證證明因果不成立）。
- 不要照抄 relay fork 的 raw HTTP/SSE（無 timeout、interrupt no-op，會重新引入無限 hang）。
- 不要改動 prompt 行為。

#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, isProcessAlive, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { truncateToByteBudget } from "./lib/strings.mjs";
import {
  applyJobPatchIfActive,
  claimTerminalTransition,
  generateJobId,
  getConfig,
  listJobs,
  readJobFile,
  resolveJobDoneFile,
  resolveJobFile,
  resolveJobFileInStateDir,
  resolveJobLogFile,
  setConfig,
  upsertJob,
  writeCompletionSignalFile,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  indexedTerminalStatus,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

// Defaults applied when the caller does not pass --model / --effort. Overridable
// via env so a workspace can pin a different model or dial reasoning effort
// down (the GPT-5.5 guide suggests re-evaluating lower effort before escalating).
function resolveDefaultModel() {
  const fromEnv = process.env.CODEX_DEFAULT_MODEL?.trim();
  return fromEnv || "gpt-5.5";
}
function resolveDefaultEffort() {
  const fromEnv = process.env.CODEX_DEFAULT_EFFORT?.trim().toLowerCase();
  if (fromEnv && VALID_REASONING_EFFORTS.has(fromEnv)) {
    return fromEnv;
  }
  return "xhigh";
}
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return resolveDefaultModel();
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return resolveDefaultModel();
  }
  // Forward the requested model verbatim. The plugin deliberately does not
  // alias or rewrite model names: the old `spark` -> `gpt-5.3-codex-spark`
  // alias pointed at a slug that does not exist in Codex's model catalog and
  // was sent literally to the provider, surfacing only as an opaque turn
  // failure. Callers pass real Codex model ids (e.g. gpt-5.3-codex).
  return normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return resolveDefaultEffort();
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return resolveDefaultEffort();
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  // Steer the user to log in whenever they are not authenticated, UNLESS we
  // positively know auth is unnecessary (requiresOpenaiAuth === false). When the
  // account/config read failed, requiresOpenaiAuth is null (unknown) — we must
  // still surface login guidance rather than silently dropping it.
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth !== false) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

// Codex's API rejects inputs over ~1 MB. The adversarial-review prompt inlines
// the collected review content (self-collect diffs + untracked files) verbatim,
// which is otherwise unbounded. Cap the FINAL rendered prompt well under the hard
// limit, truncating only the variable review input on a UTF-8 boundary so a huge
// diff degrades to a truncated-but-valid prompt instead of a hard API failure.
export const MAX_REVIEW_PROMPT_BYTES = 800 * 1024;
const REVIEW_TRUNCATION_NOTICE =
  "\n\n[... review input truncated to fit the Codex input size limit; review the most relevant changes above ...]\n";

export function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  const render = (reviewInput) =>
    interpolateTemplate(template, {
      REVIEW_KIND: "Adversarial Review",
      TARGET_LABEL: context.target.label,
      USER_FOCUS: focusText || "No extra focus provided.",
      REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
      REVIEW_INPUT: reviewInput
    });

  const full = render(context.content);
  if (Buffer.byteLength(full, "utf8") <= MAX_REVIEW_PROMPT_BYTES) {
    return full;
  }

  // Reserve room for the template framing (everything except REVIEW_INPUT) and
  // the truncation notice, then fit the review content into what remains.
  const overheadBytes = Buffer.byteLength(render(""), "utf8") + Buffer.byteLength(REVIEW_TRUNCATION_NOTICE, "utf8");
  const contentBudget = Math.max(0, MAX_REVIEW_PROMPT_BYTES - overheadBytes);
  const truncated = `${truncateToByteBudget(context.content, contentBudget)}${REVIEW_TRUNCATION_NOTICE}`;
  const rendered = render(truncated);
  if (Buffer.byteLength(rendered, "utf8") <= MAX_REVIEW_PROMPT_BYTES) {
    return rendered;
  }
  // Final hard backstop: the framing itself (e.g. an oversized USER_FOCUS) can
  // exceed the cap even after REVIEW_INPUT is emptied. Truncate the entire
  // rendered prompt so we never blow the Codex API input limit. This is a no-op
  // on the normal path; here it trims the tail to guarantee a sendable request.
  return truncateToByteBudget(rendered, MAX_REVIEW_PROMPT_BYTES);
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "workspace-write" : "read-only",
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

export function renderQueuedTaskLaunch(payload) {
  // Human line + a machine-readable sentinel so a consumer scanning stdout can
  // reliably detect the dispatch and capture the job id without parsing prose.
  return (
    `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n` +
    `[[codex-task status=dispatched id=${payload.jobId}]]\n`
  );
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function spawnWatchdog(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-watchdog.mjs");
  const child = spawn(process.execPath, [scriptPath, "--cwd", cwd, "--job", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request, deps = {}) {
  const spawnWorker = deps.spawnWorker ?? spawnDetachedTaskWorker;
  const launchWatchdog = deps.spawnWatchdog ?? spawnWatchdog;
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request,
    // Background jobs are designed to outlive the dispatching session/turn (e.g. a
    // subagent-dispatched --background rescue). SessionEnd cleanup must not reap them.
    background: true
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  // Launch the detached liveness watchdog so a hung or dead background turn is
  // reconciled to a terminal state (and a .done signal written) even when no
  // one polls /codex:status. Best effort: a watchdog spawn failure must never
  // block the actual task launch.
  try {
    launchWatchdog(cwd, job.id);
  } catch {
    appendLogLine(logFile, "Warning: liveness watchdog failed to start.");
  }

  const signalFile = resolveJobDoneFile(job.workspaceRoot, job.id);
  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      signalFile
    },
    logFile,
    signalFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: normalizeRequestedModel(options.model),
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  // Only signal a pid we can still see alive. Terminating blindly risks hitting
  // a recycled pid once the original worker has exited; the dead-PID reconcile
  // already flips crashed "running" jobs to a terminal state independently.
  if (Number.isInteger(job.pid) && job.pid > 0 && isProcessAlive(job.pid)) {
    terminateProcessTree(job.pid);
  }
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const cancelPatch = {
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    cancelledAt: completedAt,
    errorMessage: "Cancelled by user."
  };

  // Route the durable write through the CAS so a job that finalized itself
  // (the worker completed/failed during the interrupt await above — a real
  // cross-process TOCTOU) is not clobbered back to "cancelled". First terminal
  // writer wins, consistent with the runner, watchdog, and dead-PID reconcile.
  const result = applyJobPatchIfActive(workspaceRoot, job.id, () => cancelPatch);

  // Defensive fallback: the per-job file was pruned mid-flight (stored===null),
  // so there is no terminal record to clobber — recreate the cancelled record,
  // but ONLY if no other actor already finalized the job in the shared index.
  // Without this guard cancel could resurrect a job to "cancelled" that the
  // index already records as completed/failed (matches the runner/failure
  // recreate guards — first terminal writer wins).
  const recreatedCancelled =
    !result.applied &&
    result.stored === null &&
    !indexedTerminalStatus(workspaceRoot, job.id) &&
    claimTerminalTransition(workspaceRoot, job.id, "cancelled", completedAt);
  if (recreatedCancelled) {
    writeJobFile(workspaceRoot, job.id, { ...existing, ...job, ...cancelPatch });
    upsertJob(workspaceRoot, { id: job.id, ...cancelPatch });
  }

  const finalizedAsCancelled = result.applied || recreatedCancelled;
  const finalStatus = finalizedAsCancelled
    ? "cancelled"
    : result.stored?.status ?? indexedTerminalStatus(workspaceRoot, job.id) ?? "cancelled";

  if (finalizedAsCancelled) {
    // Terminal signal so a monitor waiting on <jobId>.done wakes after a user
    // cancellation (the watchdog also exits on terminal state, so it cannot
    // backfill this signal). Skipped when the CAS lost to an existing terminal
    // state — that actor already wrote the authoritative signal.
    writeCompletionSignalFile(workspaceRoot, job.id, {
      status: "cancelled",
      reason: "Cancelled by user."
    });
  }

  const nextJob = { ...job, ...cancelPatch, status: finalStatus };
  const payload = {
    jobId: job.id,
    status: finalStatus,
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

// Poll-and-tail loop for /codex:attach: emit new log bytes, and once the job
// reaches a terminal status do one final flush and exit. Fully seam-injectable
// (readChunk/readStatus/sleep/write) for deterministic tests; maxPolls is a
// safety bound so a never-terminal job can't loop forever.
export async function streamJobLog(deps = {}) {
  const readChunk = deps.readChunk ?? (() => "");
  const readStatus = deps.readStatus ?? (() => null);
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const write = deps.write ?? ((text) => process.stdout.write(text));
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  const maxPolls = deps.maxPolls ?? Number.POSITIVE_INFINITY;
  // If the per-job record can't be read (pruned by MAX_JOBS eviction, or resolved
  // to the wrong state dir), readStatus returns null. Give up after a bounded run
  // of consecutive nulls so the tail degrades to a clean stop instead of looping
  // forever. A readable status resets the run.
  const maxConsecutiveNullStatus = deps.maxConsecutiveNullStatus ?? 20;

  let polls = 0;
  let nullStatusRun = 0;
  for (;;) {
    const chunk = readChunk();
    if (chunk) {
      write(chunk);
    }
    const status = readStatus();
    if (status && TERMINAL_JOB_STATUSES.has(status)) {
      const tail = readChunk();
      if (tail) {
        write(tail);
      }
      return status;
    }
    if (status == null) {
      nullStatusRun += 1;
      if (nullStatusRun >= maxConsecutiveNullStatus) {
        return null;
      }
    } else {
      nullStatusRun = 0;
    }
    polls += 1;
    if (polls >= maxPolls) {
      return status;
    }
    await sleep(pollIntervalMs);
  }
}

export async function handleAttach(argv, deps = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "poll-interval-ms"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const reference = positionals.join(" ").trim() || null;

  // Resolve the job: an explicit reference (local, then cross-workspace via
  // buildSingleJobSnapshot's fallback), else the newest still-active job in the
  // current workspace.
  let workspaceRoot;
  let jobId;
  let logFile;
  let statusFile;
  if (reference) {
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    workspaceRoot = snapshot.workspaceRoot;
    jobId = snapshot.job.id;
    logFile = snapshot.job.logFile ?? resolveJobLogFile(workspaceRoot, jobId);
    // For a cross-workspace hit, read status from the job's PHYSICAL state dir;
    // re-deriving from workspaceRoot can resolve to a different (missing) path.
    statusFile = snapshot.stateDir
      ? resolveJobFileInStateDir(snapshot.stateDir, jobId)
      : resolveJobFile(workspaceRoot, jobId);
  } else {
    workspaceRoot = resolveCommandWorkspace(options);
    const active = sortJobsNewestFirst(listJobs(workspaceRoot)).find(
      (job) => job.status === "queued" || job.status === "running"
    );
    if (!active) {
      throw new Error("No active Codex job to attach to. Run /codex:status to inspect known jobs.");
    }
    jobId = active.id;
    logFile = active.logFile ?? resolveJobLogFile(workspaceRoot, jobId);
    statusFile = resolveJobFile(workspaceRoot, jobId);
  }

  let offset = 0;
  const readChunk =
    deps.readChunk ??
    (() => {
      try {
        const buf = fs.readFileSync(logFile);
        if (buf.length <= offset) {
          return "";
        }
        const slice = buf.subarray(offset).toString("utf8");
        offset = buf.length;
        return slice;
      } catch {
        return ""; // log not created yet / transient read error — try again next poll
      }
    });
  const readStatus =
    deps.readStatus ??
    (() => {
      try {
        return readJobFile(statusFile)?.status ?? null;
      } catch {
        return null;
      }
    });

  const pollIntervalMs = deps.pollIntervalMs ?? (Number(options["poll-interval-ms"]) || 500);
  return streamJobLog({
    readChunk,
    readStatus,
    sleep: deps.sleep,
    write: deps.write,
    pollIntervalMs,
    // Finite production ceiling (past the 1-hour job hard cap) so a job that
    // never reaches a readable terminal state can't tail forever. 7800 polls ×
    // 500ms ≈ 65 min, leaving headroom beyond DEFAULT_JOB_TIMEOUT_MS so a healthy
    // long job is still followed to its own terminal state, not cut off early.
    maxPolls: deps.maxPolls ?? 7800,
    maxConsecutiveNullStatus: deps.maxConsecutiveNullStatus
  });
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "attach":
      await handleAttach(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

// Structured failure envelope mirrored to stdout. The codex-rescue subagent (and
// other machine consumers) capture stdout only, so a stderr-only failure is
// invisible to them — they would see an empty result and assume success.
export function buildMainErrorEnvelope(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { status: "error", error: message, exitCode: 1 };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    const envelope = buildMainErrorEnvelope(error);
    // stdout: structured envelope for machine consumers (rescue subagent).
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    // stderr: the human-readable message, as before.
    process.stderr.write(`${envelope.error}\n`);
    process.exitCode = envelope.exitCode;
  });
}

export { enqueueBackgroundTask, spawnDetachedTaskWorker };

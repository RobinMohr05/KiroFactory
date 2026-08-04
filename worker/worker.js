/**
 * Vibecode Heaven Worker Agent
 *
 * Runs inside an Azure Container Apps Job. Responsibilities:
 * 1. Connect to the orchestrator via WebSocket (with retry — the orchestrator
 *    waits up to 180s, so a slow start or brief network hiccup must not kill us)
 * 2. Authenticate, then announce readiness (worker-ready)
 * 3. Clone the repo and set up the workspace
 * 4. Spawn kiro-cli acp and stream its output back to the orchestrator
 * 5. Accept prompts pushed by the orchestrator over the WebSocket
 * 6. On stop/completion: commit, push, then exit
 *
 * IMPORTANT: the message protocol must match backend/src/worker-ws-handler.ts.
 * The orchestrator routes on `msg.action` (NOT `msg.type`) and expects:
 *   worker → orchestrator: worker-auth, worker-ready, output, session-update,
 *                          prompt-done, worker-exited, worker-shutdown
 *   orchestrator → worker: prompt, stop, auth-ok, auth-failed
 */

import { spawn, execSync, execFileSync } from "node:child_process";
import { WebSocket } from "ws";
import { mkdirSync, existsSync, writeFileSync, appendFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Configuration (from environment variables injected by orchestrator)
// ---------------------------------------------------------------------------

const SESSION_ID = process.env.SESSION_ID;
// Env vars are always strings; the orchestrator's sessions.id column is now
// an INT (auto-increment), so every outgoing message must send it as a
// number to match backend/src/worker-ws-handler.ts's WorkerMessage type.
const SESSION_ID_NUM = Number(SESSION_ID);
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;
const TASK_ID = process.env.TASK_ID;
const AGENT_NAME = process.env.AGENT_NAME ?? "developer-agent";
/** Agent kind: "editor" commits/pushes changes, "inspector" discards unexpected changes. */
const AGENT_KIND = process.env.AGENT_KIND || "editor";
const REPO_URL = process.env.REPO_URL;
const DEV_BRANCH_CANDIDATES = (process.env.DEV_BRANCH || "develop").split(",").map(b => b.trim());
let DEV_BRANCH = DEV_BRANCH_CANDIDATES[0];
const KIRO_API_KEY = process.env.KIRO_API_KEY;
const GIT_USER_NAME = process.env.GIT_USER_NAME || "Vibecode Heaven Agent";
const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL || "agent@vibecode-heaven.dev";
const AZURE_DEVOPS_PAT = process.env.AZURE_DEVOPS_PAT;
/** Provider resolved by the orchestrator ("github" | "azure-devops"), if any. */
const GIT_PROVIDER = process.env.GIT_PROVIDER || "";
const PROMPT_TEXT = process.env.PROMPT_TEXT || "";

const WORKSPACE = "/workspace";

// Connection retry: 30 attempts × 5s ≈ 150s, comfortably inside the
// orchestrator's 180s connect window. Without retry, a single failed attempt
// used to let the Node event loop drain and the process exited 0 in ~100ms —
// which the orchestrator saw as "job Succeeded but worker never connected".
const CONNECT_MAX_ATTEMPTS = 30;
const CONNECT_RETRY_DELAY_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Small structured logger → stdout (captured as ContainerAppConsoleLogs_CL)
// ---------------------------------------------------------------------------

function logInfo(msg, extra) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", component: "worker", sessionId: SESSION_ID_NUM, msg, ...extra }));
}
function logError(msg, extra) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", component: "worker", sessionId: SESSION_ID_NUM, msg, ...extra }));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (!SESSION_ID || !ORCHESTRATOR_URL || !WORKER_SECRET) {
  logError("Missing required env vars", {
    hasSessionId: !!SESSION_ID,
    hasOrchestratorUrl: !!ORCHESTRATOR_URL,
    hasWorkerSecret: !!WORKER_SECRET,
  });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// WebSocket connection to orchestrator (with retry)
// ---------------------------------------------------------------------------

let ws = null;
let connected = false;
let authenticated = false;
let heartbeatTimer = null;

/** Prompts that arrived before kiro-cli was ready to receive them. */
const promptQueue = [];
let kiroReady = false;
let promptCounter = 0;
let currentPromptId = null;
/** Current task metadata (set when a prompt arrives with task info). */
let currentTaskMeta = null;
/** The branch name for the current task. */
let currentBranchName = null;

function connectWithRetry(attempt = 1) {
  logInfo("Connecting to orchestrator", { url: ORCHESTRATOR_URL, attempt, maxAttempts: CONNECT_MAX_ATTEMPTS });

  ws = new WebSocket(ORCHESTRATOR_URL);

  // If the socket neither opens nor errors (e.g. stuck TLS handshake), don't
  // hang forever — force a retry.
  const openTimeout = setTimeout(() => {
    if (!connected) {
      logError("Connection attempt timed out", { attempt });
      try { ws.terminate(); } catch { /* noop */ }
    }
  }, CONNECT_RETRY_DELAY_MS);

  ws.on("open", () => {
    clearTimeout(openTimeout);
    connected = true;
    logInfo("WebSocket open — authenticating");

    ws.send(JSON.stringify({
      action: "worker-auth",
      sessionId: SESSION_ID_NUM,
      secret: WORKER_SECRET,
    }));

    startHeartbeat();
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignore non-JSON
    }
    handleOrchestratorMessage(msg);
  });

  ws.on("close", (code, reason) => {
    clearTimeout(openTimeout);
    stopHeartbeat();
    const wasConnected = connected;
    connected = false;

    if (authenticated) {
      // We were fully connected then lost the socket — the session is over.
      logInfo("Disconnected from orchestrator after auth — exiting", { code, reason: reason?.toString() });
      gracefulShutdown(0);
      return;
    }

    // Never authenticated — retry unless we've exhausted attempts.
    logError("Socket closed before authentication", { code, reason: reason?.toString(), attempt });
    retryOrGiveUp(attempt);
  });

  ws.on("error", (err) => {
    clearTimeout(openTimeout);
    // Log but let the "close" handler drive retry/give-up so we don't do it twice.
    logError("WebSocket error", { attempt, error: err?.message || String(err) });
  });
}

function retryOrGiveUp(attempt) {
  if (attempt >= CONNECT_MAX_ATTEMPTS) {
    logError("Could not connect to orchestrator after all attempts — exiting non-zero", {
      attempts: attempt,
      url: ORCHESTRATOR_URL,
      hint: "Verify ORCHESTRATOR_URL is a reachable wss:// endpoint (e.g. wss://<api-fqdn>/internal/worker) and that the worker job can reach the orchestrator's ingress.",
    });
    // Non-zero exit → ACA marks the job Failed (not Succeeded), making it
    // obvious the worker could not connect rather than exiting cleanly.
    process.exit(1);
  }
  setTimeout(() => connectWithRetry(attempt + 1), CONNECT_RETRY_DELAY_MS);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (connected && ws?.readyState === WebSocket.OPEN) {
      try { ws.ping(); } catch { /* noop */ }
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Outgoing messages (action-based — must match worker-ws-handler.ts)
// ---------------------------------------------------------------------------

function send(action, payload = {}) {
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ action, sessionId: SESSION_ID_NUM, ...payload }));
}

/** Send an output line. `stream` is one of "stdout" | "stderr" | "system". */
function sendOutput(text, stream = "stdout") {
  send("output", { entry: { timestamp: new Date().toISOString(), stream, text } });
}

function sendReady(acpSessionId) {
  send("worker-ready", { acpSessionId });
}

function sendSessionUpdate(update) {
  send("session-update", { update });
}

function sendPromptDone(result) {
  send("prompt-done", { result });
}

function sendShutdown(exitCode) {
  send("worker-shutdown", { exitCode });
}

// ---------------------------------------------------------------------------
// Orchestrator → worker message handling
// ---------------------------------------------------------------------------

function handleOrchestratorMessage(msg) {
  switch (msg.action) {
    case "auth-ok":
      authenticated = true;
      logInfo("Authenticated with orchestrator");
      onAuthenticated().catch((err) => {
        logError("Startup failed after authentication", { error: err?.message || String(err) });
        sendOutput(`Worker startup failed: ${err?.message || String(err)}`, "stderr");
        gracefulShutdown(1);
      });
      break;

    case "auth-failed":
      logError("Authentication rejected by orchestrator", { reason: msg.reason });
      process.exit(1);
      break;

    case "prompt":
      handlePrompt(String(msg.text ?? ""), msg.taskMeta || null);
      break;

    case "stop":
      logInfo("Received stop signal from orchestrator");
      gracefulShutdown(0);
      break;

    default:
      // Unknown/keepalive — ignore.
      break;
  }
}

// ---------------------------------------------------------------------------
// Git operations
// ---------------------------------------------------------------------------

/**
 * Strip credentials out of anything we are about to log or forward.
 * Git commands and git's own error messages echo the remote URL, which carries
 * the PAT — that must never reach the container log or the session output.
 */
function redactSecrets(text) {
  if (typeof text !== "string" || !text) return text;
  // https://user:token@host → https://***@host
  let out = text.replace(/(https?:\/\/)[^@\s/"']+@/g, "$1***@");
  for (const secret of [process.env.GITHUB_PAT, AZURE_DEVOPS_PAT, KIRO_API_KEY]) {
    if (secret && secret.length >= 8) out = out.split(secret).join("***");
  }
  return out;
}

/**
 * Run a shell command in the workspace.
 *
 * GIT_TERMINAL_PROMPT=0 makes git fail immediately when it would otherwise ask
 * for a username — in a container that prompt surfaces as the confusing
 * "could not read Username for 'https://github.com': No such device or address".
 */
function exec(cmd, opts = {}) {
  logInfo("exec", { cmd: redactSecrets(cmd) });
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      ...opts,
    }).trim();
  } catch (err) {
    // execSync embeds the full command (and therefore the PAT) in the message.
    if (err && typeof err.message === "string") err.message = redactSecrets(err.message);
    throw err;
  }
}

/**
 * Run a command with an explicit argv array — no shell involved.
 *
 * Use this instead of exec() whenever an argument can contain arbitrary text
 * (task titles/descriptions), since those routinely contain double quotes,
 * backticks, or `$(...)` that break shell-string interpolation. exec()'s
 * naive `"${value}"` embedding is what caused git commit to fail with
 * "Syntax error: word unexpected" whenever a task title itself contained a
 * quote character (e.g. `Fix duplicate pinned "Chat" session`).
 */
function execFileArgs(file, args, opts = {}) {
  logInfo("execFile", { file, args: args.map((a) => redactSecrets(a)) });
  try {
    return execFileSync(file, args, {
      encoding: "utf-8",
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      ...opts,
    }).trim();
  } catch (err) {
    if (err && typeof err.message === "string") err.message = redactSecrets(err.message);
    throw err;
  }
}

/**
 * Slugify a title for branch naming: lowercase, spaces→hyphens, strip invalid chars, truncate.
 */
function slugifyTitle(title) {
  return title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60)
    .replace(/-+$/, "");
}

/**
 * Build a task-specific branch name: [type]/#[id]_[slug]
 */
function buildBranchName(taskType, taskId, taskTitle) {
  return `${taskType}/#${taskId}_${slugifyTitle(taskTitle)}`;
}

/**
 * Reset the working tree so a branch checkout can't fail on a dirty state.
 *
 * This runs before starting a new task. Any committed work of the previous task
 * has already been pushed at this point, so leftover modifications are either
 * a failed commit or debris from an aborted attempt — both safe to discard in
 * this ephemeral container clone.
 */
function resetWorkingTree() {
  try {
    const leftover = exec("git status --porcelain", { cwd: WORKSPACE });
    if (!leftover) return;
    sendOutput(`Discarding leftover working-tree changes before branching:\n${leftover}`, "system");
    logInfo("Discarding leftover working-tree changes", { files: leftover.split("\n").length });
    exec("git reset --hard HEAD", { cwd: WORKSPACE });
    exec("git clean -fd", { cwd: WORKSPACE });
  } catch (err) {
    logError("resetWorkingTree failed", { error: err?.message || String(err) });
  }
}

/**
 * Create a task-specific branch from a clean DEV_BRANCH state.
 *
 * Uses `checkout -B` (create-or-reset) instead of `-b`: when a task is retried
 * after a failed attempt the branch from the previous attempt still exists
 * locally, and `-b` fails with "a branch named ... already exists" — which used
 * to leave the agent working on the stale branch.
 */
function createTaskBranch(taskMeta) {
  const branchName = buildBranchName(taskMeta.type || "task", taskMeta.id, taskMeta.title);
  resetWorkingTree();
  // execFileArgs — not exec() — so nothing DEV_BRANCH/branchName contain can
  // ever be re-parsed by a shell (see the note on execFileArgs() below).
  execFileArgs("git", ["checkout", DEV_BRANCH], { cwd: WORKSPACE });
  execFileArgs("git", ["checkout", "-B", branchName, DEV_BRANCH], { cwd: WORKSPACE });
  sendOutput(`Created branch: ${branchName} (from ${DEV_BRANCH})`, "system");
  return branchName;
}

/**
 * REPO_URL with the PAT embedded. Used for every network operation (clone,
 * push) because the container has no credential helper and no tty: without
 * inline credentials git tries to prompt for a username and dies with
 * "could not read Username for 'https://github.com': No such device or address".
 *
 * Never logged — always pass through redactSecrets().
 */
let authRemoteUrl = null;

/** True when we have a credential that can push to REPO_URL. */
function hasPushCredential() {
  switch (detectGitProvider(REPO_URL)) {
    case "github":
      return !!process.env.GITHUB_PAT;
    case "azure-devops":
      return !!AZURE_DEVOPS_PAT;
    default:
      return false;
  }
}

/** Remove any `user@` / `user:pass@` part already present in a URL. */
function stripUserInfo(url) {
  return url.replace(/^(https?:\/\/)[^@/]+@/, "$1");
}

function buildAuthRemoteUrl() {
  if (!REPO_URL) return null;

  // Azure DevOps clone URLs are often handed out as https://{org}@dev.azure.com/...
  // Injecting credentials without dropping that part produces a malformed URL.
  const base = stripUserInfo(REPO_URL);

  switch (detectGitProvider(REPO_URL)) {
    case "azure-devops":
      // Azure DevOps accepts a PAT as the password with any (or empty) username.
      return AZURE_DEVOPS_PAT
        ? base.replace("https://", `https://pat:${AZURE_DEVOPS_PAT}@`)
        : base;
    case "github":
      // x-access-token is the documented username for GitHub token auth and works
      // for classic and fine-grained PATs as well as GitHub App tokens.
      return process.env.GITHUB_PAT
        ? base.replace("https://", `https://x-access-token:${process.env.GITHUB_PAT}@`)
        : base;
    default:
      return base;
  }
}

/**
 * Confirm we can actually push before the agent spends minutes producing work
 * that can't be delivered. `--dry-run` performs the full auth and permission
 * check against the remote without creating anything.
 */
function verifyPushAccess() {
  const provider = detectGitProvider(REPO_URL);

  if (provider === "unknown") {
    logError("Git provider unresolved — cannot determine which credential to use", {
      repoUrl: redactSecrets(REPO_URL),
    });
    sendOutput(
      `The repository host was not recognised and no git provider was selected, so no ` +
        `credential could be chosen. Pick a provider on this tab, or set a profile default ` +
        `in Settings.`,
      "stderr"
    );
    return false;
  }

  if (!hasPushCredential()) {
    const host = provider === "github" ? "GitHub" : "Azure DevOps";
    const credName = provider === "github" ? "githubPat" : "azureDevOpsPat";
    logError("No git push credential injected", { provider, requiredCredential: credName });
    sendOutput(
      `No ${host} credential was injected into this worker. The repository could be cloned ` +
        `(public read access), but pushing WILL fail. Store a ${credName} credential for this ` +
        `user so the orchestrator can pass it to the worker.`,
      "stderr"
    );
    return false;
  }

  try {
    execFileArgs("git", ["push", "--dry-run", authRemoteUrl, "HEAD:refs/heads/__vch_push_preflight__"], {
      cwd: WORKSPACE,
    });
    logInfo("Push access verified");
    sendOutput("Git push access verified", "system");
    return true;
  } catch (err) {
    const msg = redactSecrets(err?.message || String(err));
    logError("Push access check failed", { error: msg });
    sendOutput(
      `Git push access check failed — the agent's work will not be deliverable:\n${msg}`,
      "stderr"
    );
    return false;
  }
}

function setupRepo() {
  if (!REPO_URL) {
    logInfo("No REPO_URL — working in empty workspace");
    mkdirSync(WORKSPACE, { recursive: true });
    return;
  }

  authRemoteUrl = buildAuthRemoteUrl();

  const provider = detectGitProvider(REPO_URL);
  logInfo("Git configuration", {
    repoUrl: redactSecrets(REPO_URL),
    provider,
    providerSource: GIT_PROVIDER ? "orchestrator" : "url-detection",
    devBranch: DEV_BRANCH,
    hasGithubPat: !!process.env.GITHUB_PAT,
    hasAzureDevOpsPat: !!AZURE_DEVOPS_PAT,
    hasPushCredential: hasPushCredential(),
  });
  sendOutput(
    `Git provider: ${provider} (${GIT_PROVIDER ? "selected in settings" : "detected from URL"})`,
    "system"
  );

  sendOutput("Cloning repository...", "system");

  // Try each candidate branch in order (develop → dev → main)
  const branchesToTry = DEV_BRANCH_CANDIDATES.length > 1
    ? DEV_BRANCH_CANDIDATES
    : ["develop", "dev", "main"];
  let clonedBranch = null;
  for (const branch of branchesToTry) {
    try {
      execFileArgs("git", ["clone", "--branch", branch, authRemoteUrl, WORKSPACE]);
      clonedBranch = branch;
      break;
    } catch {
      // Branch doesn't exist on remote, try next
      try {
        execFileArgs("rm", ["-rf", WORKSPACE]);
      } catch { /* ignore cleanup errors */ }
    }
  }

  if (!clonedBranch) {
    throw new Error(
      `None of the branches [${branchesToTry.join(", ")}] exist on remote for ${redactSecrets(REPO_URL)}`
    );
  }

  // Update DEV_BRANCH to the branch that was actually cloned
  DEV_BRANCH = clonedBranch;

  // Keep the PAT out of .git/config — pushes use authRemoteUrl explicitly.
  execFileArgs("git", ["remote", "set-url", "origin", REPO_URL], { cwd: WORKSPACE });

  execFileArgs("git", ["config", "user.name", GIT_USER_NAME], { cwd: WORKSPACE });
  execFileArgs("git", ["config", "user.email", GIT_USER_EMAIL], { cwd: WORKSPACE });

  verifyPushAccess();

  // Ensure the workspace has a .kiro/agents/ config for kiro-cli.
  // If the target repo already has one, we leave it alone. Otherwise, we inject
  // the default developer-agent configuration so kiro-cli can function.
  ensureAgentConfig();

  // Install dependencies so the agent can run tests, builds, etc.
  sendOutput("Installing dependencies...", "system");
  try {
    if (existsSync(`${WORKSPACE}/package-lock.json`)) {
      exec("npm ci", { cwd: WORKSPACE, timeout: 300_000 });
    } else if (existsSync(`${WORKSPACE}/package.json`)) {
      exec("npm install", { cwd: WORKSPACE, timeout: 300_000 });
    }
  } catch (err) {
    sendOutput(`Warning: npm install failed: ${err?.message || err}`, "stderr");
    logError("npm install failed", { error: err?.message || String(err) });
  }

  sendOutput(`Workspace ready on branch ${DEV_BRANCH}`, "system");
}

/**
 * Ensure the workspace has a .kiro/agents/<AGENT_NAME>.json so kiro-cli
 * can find the agent configuration. If the target repo already ships one,
 * we respect it. Otherwise, we create a sensible default.
 */
function ensureAgentConfig() {
  if (!AGENT_NAME) {
    logInfo("No agent configured — skipping agent config injection");
    return;
  }
  const kiroDir = `${WORKSPACE}/.kiro`;
  const agentsDir = `${kiroDir}/agents`;
  const agentFile = `${agentsDir}/${AGENT_NAME}.json`;

  if (existsSync(agentFile)) {
    logInfo("Agent config already exists in workspace", { path: agentFile });
    return;
  }

  mkdirSync(agentsDir, { recursive: true });

  // Default agent config: full tool access, no restrictive allowedTools list.
  // The prompt itself constrains what the agent should do — the tools should be
  // available for it to actually make changes.
  const agentConfig = {
    name: AGENT_NAME,
    description: "Developer agent that implements assigned tasks. Reads code, makes changes, verifies the build.",
    prompt: [
      "You are the Developer Implementation Agent.",
      "You will be given a specific task to implement. Do NOT pick tasks yourself — your task is provided in the prompt.",
      "",
      "## RULES",
      "",
      "1. Read relevant source files to understand the current state before making changes.",
      "2. Implement the change described in your assigned task.",
      "3. Follow the existing code style and conventions.",
      "4. After implementing, verify your changes compile correctly (run the project's build command).",
      "5. Keep changes minimal and focused on the assigned task only.",
      "6. Do NOT introduce unrelated refactoring or improvements.",
      "7. If the work is already implemented, note that and stop.",
      "8. If the task cannot be completed, explain why and stop.",
      "9. STOP after completing the single assigned task.",
      "10. Do NOT run any git commands. The orchestrator handles all git operations.",
    ].join("\n"),
    tools: [
      "read",
      "write",
      "shell",
      "grep",
      "glob",
      "code"
    ],
  };

  writeFileSync(agentFile, JSON.stringify(agentConfig, null, 2), "utf-8");
  logInfo("Created agent config in workspace", { path: agentFile });
  sendOutput(`Injected .kiro/agents/${AGENT_NAME}.json into workspace`, "system");

  // Keep the injected config out of `git status` — otherwise it would be
  // committed as part of every task AND would make the "did the agent change
  // anything?" check report a false positive.
  try {
    if (existsSync(`${WORKSPACE}/.git/info`)) {
      appendFileSync(`${WORKSPACE}/.git/info/exclude`, `\n.kiro/agents/${AGENT_NAME}.json\n`, "utf-8");
    }
  } catch (err) {
    logError("Could not add injected agent config to .git/info/exclude", { error: err?.message || String(err) });
  }
}

function commitAndPush() {
  let status = "";
  try {
    status = exec("git status --porcelain", { cwd: WORKSPACE });
  } catch {
    return { pushed: false, hasChanges: false }; // not a git workspace
  }
  if (!status) {
    // Report the branch and HEAD too, so "the agent produced nothing" can be
    // told apart from "we were on the wrong branch" or "the repo was reset".
    let branch = "?";
    let head = "?";
    try {
      branch = exec("git rev-parse --abbrev-ref HEAD", { cwd: WORKSPACE });
      head = exec("git log -1 --oneline", { cwd: WORKSPACE });
    } catch { /* noop */ }
    sendOutput(`No changes to commit (branch: ${branch}, HEAD: ${head})`, "system");
    logInfo("No changes to commit", { branch, head });
    return { pushed: false, hasChanges: false };
  }

  const changedFiles = status.split("\n").filter(Boolean);
  sendOutput(
    `${changedFiles.length} changed file(s):\n${changedFiles.map((l) => `  ${l}`).join("\n")}`,
    "system"
  );
  logInfo("Committing agent changes", { fileCount: changedFiles.length, files: changedFiles.slice(0, 50) });

  exec("git add -A", { cwd: WORKSPACE });

  // Build commit message with task info.
  //
  // Task titles/descriptions are free-form user (or agent-generated) text and
  // routinely contain double quotes, backticks, or `$(...)`. Passing them
  // through a shell string (exec()) is unsafe — any of those characters
  // breaks the command with a syntax error. execFileArgs() invokes git
  // directly with an argv array, so the commit message is never re-parsed
  // by a shell no matter what it contains.
  const taskId = currentTaskMeta?.id || TASK_ID || "unknown";
  const taskTitle = currentTaskMeta?.title || `task ${taskId}`;
  const commitTitle = `${taskTitle} [Vibecode Heaven #${taskId}]`;
  const commitBody = currentTaskMeta
    ? `\nType: ${currentTaskMeta.type || "unknown"}\nID: ${taskId}\n\n${currentTaskMeta.description || ""}`
    : "";
  execFileArgs("git", ["commit", "-m", `${commitTitle}${commitBody}`], { cwd: WORKSPACE });

  const branchName = currentBranchName || `vibecode-heaven/${SESSION_ID}`;

  // Push to the credential-carrying URL rather than the `origin` alias: the
  // container has no credential helper and no tty, so an unauthenticated push
  // fails with "could not read Username for 'https://github.com'".
  //
  // A push failure is reported, not thrown: the agent's work is real and
  // committed, and the orchestrator needs to tell "the agent produced nothing"
  // apart from "the agent produced work we could not deliver".
  try {
    execFileArgs("git", ["push", authRemoteUrl || "origin", `HEAD:refs/heads/${branchName}`], {
      cwd: WORKSPACE,
    });
  } catch (err) {
    const pushError = redactSecrets(err?.message || String(err));
    logError("git push failed", { branchName, error: pushError });
    sendOutput(`Push to ${branchName} failed: ${pushError}`, "stderr");
    return { pushed: false, hasChanges: true, committed: true, branchName, pushError };
  }

  sendOutput(`Pushed branch ${branchName}`, "system");
  return { pushed: true, hasChanges: true, committed: true, branchName };
}

// ---------------------------------------------------------------------------
// Pull request creation (GitHub and Azure DevOps)
//
// The hosting provider is not configured anywhere — it is derived from
// REPO_URL. The tab's repository URL is the single source of truth for which
// provider is used, which credential is needed, and which API creates the PR.
// ---------------------------------------------------------------------------

const GITHUB_PAT = process.env.GITHUB_PAT;

/**
 * Identify the git hosting provider.
 *
 * GIT_PROVIDER is set by the orchestrator from the tab's explicit choice or the
 * user's profile default. It wins over URL sniffing, which is only a fallback
 * and cannot recognise self-hosted GitHub Enterprise or Azure DevOps Server.
 */
function detectGitProvider(url) {
  if (GIT_PROVIDER === "github" || GIT_PROVIDER === "azure-devops") return GIT_PROVIDER;
  if (!url) return "unknown";
  if (url.includes("github.com")) return "github";
  if (url.includes("dev.azure.com") || url.includes("visualstudio.com")) return "azure-devops";
  return "unknown";
}

/** Title and body shared by every provider. */
function buildPrContent() {
  const taskId = currentTaskMeta?.id || TASK_ID || "unknown";
  const taskTitle = currentTaskMeta?.title || `Task ${taskId}`;
  const taskDescription = currentTaskMeta?.description || "";
  const taskType = currentTaskMeta?.type || "task";

  return {
    title: `${taskTitle} [KiroFactory #${taskId}]`,
    body: [
      "## Task",
      "",
      `**Title:** ${taskTitle}`,
      `**Type:** ${taskType}`,
      `**ID:** ${taskId}`,
      "",
      "## Description",
      "",
      taskDescription || "_(no description provided)_",
      "",
      "---",
      "*Created automatically by KiroFactory*",
    ].join("\n"),
  };
}

/**
 * Create a Pull Request on whichever provider hosts REPO_URL.
 * Returns the PR URL on success, or null when no PR could be created.
 */
async function createPullRequest(branchName) {
  const provider = detectGitProvider(REPO_URL);

  switch (provider) {
    case "github":
      if (!GITHUB_PAT) {
        logInfo("Skipping PR creation — GitHub repo but no GITHUB_PAT");
        sendOutput("Branch pushed, but no GitHub PAT is available to open a pull request.", "stderr");
        return null;
      }
      return createGitHubPullRequest(branchName);

    case "azure-devops":
      if (!AZURE_DEVOPS_PAT) {
        logInfo("Skipping PR creation — Azure DevOps repo but no AZURE_DEVOPS_PAT");
        sendOutput(
          "Branch pushed, but no Azure DevOps PAT is available to open a pull request.",
          "stderr"
        );
        return null;
      }
      return createAzureDevOpsPullRequest(branchName);

    default:
      logInfo("Skipping PR creation — unrecognised git host", { repoUrl: redactSecrets(REPO_URL) });
      sendOutput(
        `Branch pushed. Automatic pull requests are only supported for GitHub and Azure DevOps.`,
        "system"
      );
      return null;
  }
}

/** Create a Pull Request via the GitHub REST API. */
async function createGitHubPullRequest(branchName) {
  const match = REPO_URL.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) {
    logError("Cannot parse owner/repo from REPO_URL", { url: redactSecrets(REPO_URL) });
    return null;
  }
  const [, owner, repo] = match;
  const { title, body } = buildPrContent();

  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GITHUB_PAT}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title,
        body,
        head: branchName,
        base: DEV_BRANCH,
      }),
    });

    if (response.status === 201) {
      const data = await response.json();
      sendOutput(`Pull Request created: ${data.html_url}`, "system");
      return data.html_url;
    }

    const errorData = await response.json().catch(() => ({}));
    const errorMsg = errorData.message || `HTTP ${response.status}`;
    sendOutput(`PR creation failed: ${errorMsg}`, "stderr");
    logError("GitHub PR creation failed", { status: response.status, error: errorMsg });
    return null;
  } catch (err) {
    logError("GitHub PR creation network error", { error: err?.message || String(err) });
    sendOutput(`PR creation error: ${err?.message || err}`, "stderr");
    return null;
  }
}

/**
 * Parse organization / project / repository out of an Azure DevOps repo URL.
 * Supports both the modern and the legacy host forms:
 *   https://dev.azure.com/{org}/{project}/_git/{repo}
 *   https://{org}@dev.azure.com/{org}/{project}/_git/{repo}
 *   https://{org}.visualstudio.com/{project}/_git/{repo}
 */
function parseAzureDevOpsUrl(url) {
  const modern = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/);
  if (modern) {
    return { org: modern[1], project: modern[2], repo: modern[3].replace(/\.git$/, "") };
  }
  const legacy = url.match(/([^/.@]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/?#]+)/);
  if (legacy) {
    return { org: legacy[1], project: legacy[2], repo: legacy[3].replace(/\.git$/, "") };
  }
  return null;
}

/** Create a Pull Request via the Azure DevOps REST API. */
async function createAzureDevOpsPullRequest(branchName) {
  const parsed = parseAzureDevOpsUrl(REPO_URL);
  if (!parsed) {
    logError("Cannot parse org/project/repo from Azure DevOps REPO_URL", {
      url: redactSecrets(REPO_URL),
    });
    sendOutput(
      "Branch pushed, but the Azure DevOps repository URL could not be parsed to open a pull request.",
      "stderr"
    );
    return null;
  }

  const { org, project, repo } = parsed;
  const { title, body } = buildPrContent();

  // Azure DevOps caps the PR description at 4000 characters.
  const description = body.length > 4000 ? `${body.slice(0, 3990)}\n…` : body;

  const apiUrl =
    `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}` +
    `/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests?api-version=7.1`;

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        // Azure DevOps PATs authenticate as Basic with an empty username.
        "Authorization": `Basic ${Buffer.from(`:${AZURE_DEVOPS_PAT}`).toString("base64")}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        sourceRefName: `refs/heads/${branchName}`,
        targetRefName: `refs/heads/${DEV_BRANCH}`,
        title,
        description,
      }),
    });

    if (response.status === 200 || response.status === 201) {
      const data = await response.json();
      const prUrl =
        data?._links?.web?.href ||
        (data?.repository?.webUrl && data?.pullRequestId
          ? `${data.repository.webUrl}/pullrequest/${data.pullRequestId}`
          : null);
      sendOutput(`Pull Request created: ${prUrl || `#${data?.pullRequestId ?? "?"}`}`, "system");
      return prUrl;
    }

    const errorData = await response.json().catch(() => ({}));
    const errorMsg = errorData.message || `HTTP ${response.status}`;
    sendOutput(`PR creation failed: ${errorMsg}`, "stderr");
    logError("Azure DevOps PR creation failed", { status: response.status, error: errorMsg });
    return null;
  } catch (err) {
    logError("Azure DevOps PR creation network error", { error: err?.message || String(err) });
    sendOutput(`PR creation error: ${err?.message || err}`, "stderr");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Kiro CLI execution (persistent — accepts multiple prompts over its lifetime)
// ---------------------------------------------------------------------------

let kiroProc = null;

async function onAuthenticated() {
  // Announce readiness so the orchestrator flips the session to "connected".
  // The real ACP session id doesn't exist yet — it comes from session/new after
  // the repo is cloned and kiro-cli has started.
  sendReady("pending-handshake");

  // Set up the git workspace (may throw → caller reports and shuts down).
  setupRepo();

  // Spawn the persistent kiro-cli acp process.
  spawnKiro();

  // If a prompt was pre-provided via env (legacy path), enqueue it.
  if (PROMPT_TEXT) {
    handlePrompt(PROMPT_TEXT);
  }
}

// ---------------------------------------------------------------------------
// ACP (Agent Client Protocol) wire layer
//
// kiro-cli speaks ACP over stdio as NDJSON JSON-RPC 2.0. The method names are
// NAMESPACED — `session/new`, `session/prompt`, `session/update`,
// `session/request_permission`, `session/cancel`. Only `initialize` is
// un-namespaced. Sending `prompt` instead of `session/prompt` gets an immediate
// "method not found" error response, which looks exactly like an agent that ran
// and did nothing.
//
// Handshake order: initialize → session/new (returns the sessionId) →
// session/prompt (must use that sessionId). There is no implicit "default"
// session.
// ---------------------------------------------------------------------------

/** ID used for the ACP initialize handshake request. */
const INIT_REQUEST_ID = "__kiro_init__";
/** ID used for the ACP session/new request. */
const NEW_SESSION_REQUEST_ID = "__kiro_new_session__";
/** ACP protocol version (integer, per the ACP schema). */
const ACP_PROTOCOL_VERSION = 1;
/** Maximum time (ms) to wait for kiro-cli ACP readiness before giving up. */
const KIRO_READY_TIMEOUT_MS = 60_000;
/** Per-prompt budget. Mirrors the orchestrator's task timeout. */
const PROMPT_TIMEOUT_MS = (Number(process.env.TIMEOUT_SECONDS) || 900) * 1000;
/** Grace period after session/cancel before we give up on the turn entirely. */
const PROMPT_CANCEL_GRACE_MS = 30_000;
/** Max characters of agent text logged per chunk to the container log. */
const LOG_TEXT_LIMIT = 400;
/**
 * Max characters of captured tool call output (command stdout/stderr, diffs)
 * logged and forwarded per update. Higher than LOG_TEXT_LIMIT: a truncated
 * npm/build error is often useless, whereas a truncated chat sentence is fine.
 */
const TOOL_OUTPUT_LOG_LIMIT = 4000;

/** The ACP session id returned by session/new. Null until the handshake finishes. */
let acpSessionId = null;
/** Handle for the readiness timeout (module scope so message handlers can clear it). */
let readyTimeout = null;
/** Handle for the in-flight prompt timeout. */
let promptTimer = null;
/** Counters for the current turn, reported alongside prompt-done. */
let turnStats = { toolCalls: 0, messageChars: 0, thoughtChars: 0, startedAt: 0, credits: 0 };

function clearReadyTimeout() {
  if (readyTimeout) {
    clearTimeout(readyTimeout);
    readyTimeout = null;
  }
}

function clearPromptTimer() {
  if (promptTimer) {
    clearTimeout(promptTimer);
    promptTimer = null;
  }
}

/** Write a JSON-RPC message to kiro-cli stdin. Returns false if not writable. */
function writeToKiro(obj) {
  if (!kiroProc?.stdin?.writable) {
    logError("Cannot write to kiro-cli stdin", { method: obj?.method ?? null, id: obj?.id ?? null });
    return false;
  }
  kiroProc.stdin.write(JSON.stringify(obj) + "\n");
  return true;
}

/** Respond to a JSON-RPC request from kiro-cli with an error. */
function respondError(id, code, message) {
  writeToKiro({ jsonrpc: "2.0", id, error: { code, message } });
}

function truncate(text, limit = LOG_TEXT_LIMIT) {
  if (typeof text !== "string") return text;
  return text.length > limit ? `${text.slice(0, limit)}…(+${text.length - limit} chars)` : text;
}

/**
 * Pull human-readable text out of a tool_call / tool_call_update's `content`
 * array and `rawOutput` field.
 *
 * Without this, a failed shell command (npm install, a build, a test run) is
 * reported to the orchestrator as nothing more than "status: failed" — the
 * actual stdout/stderr that would explain *why* it failed is discarded. That
 * gap is what made a Tailwind/npm install failure impossible to diagnose from
 * the container logs afterwards; only the agent's own paraphrased commentary
 * survived.
 *
 * ACP content blocks come in a few shapes depending on agent/version:
 *   - { type: "content", content: { type: "text", text: "..." } }
 *   - { type: "text", text: "..." }               (flattened form)
 *   - { type: "diff", path, oldText, newText }
 *   - { type: "terminal", terminalId }             (no output here — display-only)
 * This handles all of them defensively rather than assuming one shape.
 */
function extractToolOutputText(update) {
  const parts = [];

  const content = Array.isArray(update?.content) ? update.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const text = block.text ?? block.content?.text;
    if (typeof text === "string" && text) {
      parts.push(text);
    } else if (block.type === "diff" && block.path) {
      parts.push(`[diff] ${block.path}`);
    }
  }

  if (update?.rawOutput !== undefined && update?.rawOutput !== null) {
    try {
      const raw =
        typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput);
      if (raw && !parts.includes(raw)) parts.push(raw);
    } catch {
      /* non-serializable rawOutput — skip */
    }
  }

  if (parts.length === 0) return null;
  return truncate(parts.join("\n"), TOOL_OUTPUT_LOG_LIMIT);
}

/**
 * Log an ACP session/update to the container log so the agent's reasoning and
 * tool usage is visible in ContainerAppConsoleLogs, not just in the UI.
 * The update itself is always forwarded to the orchestrator for rendering.
 */
function logSessionUpdate(update) {
  const kind = update?.sessionUpdate || "unknown";
  switch (kind) {
    case "agent_message_chunk": {
      const text = update.content?.text;
      if (typeof text === "string") {
        turnStats.messageChars += text.length;
        logInfo("agent-message", { text: truncate(text) });
      }
      break;
    }
    case "agent_thought_chunk": {
      const text = update.content?.text;
      if (typeof text === "string") {
        turnStats.thoughtChars += text.length;
        logInfo("agent-thought", { text: truncate(text) });
      }
      break;
    }
    case "tool_call": {
      turnStats.toolCalls += 1;
      logInfo("agent-tool-call", {
        toolCallId: update.toolCallId ?? null,
        title: update.title ?? null,
        kind: update.kind ?? null,
        status: update.status ?? null,
      });
      break;
    }
    case "tool_call_update": {
      const outputText = extractToolOutputText(update);
      logInfo("agent-tool-call-update", {
        toolCallId: update.toolCallId ?? null,
        status: update.status ?? null,
        // Always captured when present so completed-but-informative output
        // (e.g. a command that "succeeds" but prints warnings) isn't lost either.
        output: outputText,
      });
      if (update.status === "failed") {
        // Only failures are forwarded to the live output stream — successful
        // tool calls (ls, cat, grep, etc.) would otherwise flood the session
        // output. Their captured text is still in the container log above
        // (queryable via Log Analytics) for post-hoc debugging either way.
        const label = update.title || update.toolCallId || "unknown tool";
        sendOutput(
          outputText
            ? `Tool call failed: ${label}\n${outputText}`
            : `Tool call failed: ${label} (no output captured)`,
          "stderr"
        );
      }
      break;
    }
    case "plan": {
      logInfo("agent-plan", {
        entries: (update.entries || []).map((e) => `${e.status}: ${e.content}`).slice(0, 20),
      });
      break;
    }
    default:
      logInfo("agent-session-update", { kind, keys: Object.keys(update || {}) });
      break;
  }
}

/**
 * Auto-approve a session/request_permission request from the agent.
 * Without a response the agent blocks forever on its first tool call.
 */
function approvePermission(msg) {
  const options = msg.params?.options || [];
  const approve =
    options.find((o) => o.kind === "allow_always") ??
    options.find((o) => o.kind === "allow_once") ??
    options[0];

  const toolName = msg.params?.toolCall?.title || msg.params?.toolCall?.kind || "unknown tool";
  logInfo("Auto-approving tool permission", {
    tool: toolName,
    optionId: approve?.optionId ?? null,
    availableOptions: options.map((o) => o.kind),
  });

  if (!approve) {
    // No option to select — reject explicitly rather than leaving the agent hanging.
    logError("Permission request had no options — denying", { tool: toolName });
    writeToKiro({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } });
    return;
  }

  writeToKiro({
    jsonrpc: "2.0",
    id: msg.id,
    result: { outcome: { outcome: "selected", optionId: approve.optionId } },
  });
}

/**
 * Complete the current prompt turn: report the stop reason (or the JSON-RPC
 * error), then commit / push / open a PR and tell the orchestrator.
 */
function finishPromptTurn(msg) {
  clearPromptTimer();
  currentPromptId = null;

  const isError = msg.error !== undefined;
  const stopReason = msg.result?.stopReason ?? null;
  const durationMs = turnStats.startedAt ? Date.now() - turnStats.startedAt : 0;
  const promptError = isError
    ? `${msg.error?.message || "unknown error"}${msg.error?.code !== undefined ? ` (code ${msg.error.code})` : ""}${msg.error?.data ? ` — ${JSON.stringify(msg.error.data)}` : ""}`
    : null;

  if (isError) {
    logError("ACP session/prompt failed", { error: msg.error, durationMs });
    sendOutput(`Agent prompt failed: ${promptError}`, "stderr");
  } else {
    logInfo("ACP prompt turn complete", { stopReason, durationMs, ...turnStats });
    sendOutput(
      `Agent turn finished after ${Math.round(durationMs / 1000)}s ` +
        `(stopReason: ${stopReason ?? "unknown"}, tool calls: ${turnStats.toolCalls}, ` +
        `message chars: ${turnStats.messageChars})`,
      "system"
    );
    if (stopReason && stopReason !== "end_turn") {
      sendOutput(`Agent stopped early — stopReason: ${stopReason}`, "stderr");
    }
    if (turnStats.toolCalls === 0) {
      sendOutput(
        "Agent made zero tool calls this turn — it never read or wrote any file. " +
          "Check the agent configuration (tools / allowedCommands) and the prompt.",
        "stderr"
      );
    }
  }

  (async () => {
    let hasChanges = false;
    let committed = false;
    let prUrl = null;
    let gitError = null;

    if (AGENT_KIND === "inspector") {
      // Inspector-kind agents must not change files. If they did, discard the
      // changes and log a warning — but do NOT fail the task over it.
      try {
        const status = exec("git status --porcelain", { cwd: WORKSPACE });
        if (status) {
          const changedFiles = status.split("\n").filter(Boolean);
          const fileList = changedFiles.map((l) => `  ${l}`).join("\n");
          logError("Inspector-kind agent produced unexpected file changes — discarding", {
            agent: AGENT_NAME,
            fileCount: changedFiles.length,
            files: changedFiles.slice(0, 50),
          });
          sendOutput(
            `⚠ Inspector-kind agent produced ${changedFiles.length} changed file(s) — discarded:\n${fileList}`,
            "stderr"
          );
          exec("git reset --hard HEAD", { cwd: WORKSPACE });
          exec("git clean -fd", { cwd: WORKSPACE });
        }
      } catch (err) {
        logError("Inspector discard-changes check failed", { error: err?.message || String(err) });
      }
      // hasChanges stays false — inspector agents never produce deliverable changes
    } else {
      // Editor-kind: existing commit/push/PR flow
      try {
        const gitResult = commitAndPush();
        hasChanges = gitResult.hasChanges;
        committed = !!gitResult.committed;
        if (gitResult.pushError) gitError = gitResult.pushError;
        if (gitResult.pushed && gitResult.branchName) {
          prUrl = await createPullRequest(gitResult.branchName);
        }
      } catch (err) {
        gitError = redactSecrets(err?.message || String(err));
        logError("Post-prompt git/PR operations failed", { error: gitError });
        sendOutput(`Post-prompt error: ${gitError}`, "stderr");
      }
    }

    sendPromptDone({
      stopReason,
      error: promptError || gitError || null,
      // deliveryFailed = the agent did the work and it was committed, but it
      // could not be pushed. Retrying the agent cannot fix that.
      deliveryFailed: committed && !!gitError,
      toolCalls: turnStats.toolCalls,
      durationMs,
      hasChanges,
      prUrl,
      branchName: currentBranchName,
      credits: turnStats.credits || undefined,
    });
  })();
}

/**
 * Arm the per-prompt timeout. On expiry we send session/cancel and, if the
 * agent still doesn't answer, force the turn closed so the orchestrator is
 * never left waiting forever on a hung agent.
 */
function startPromptTimer() {
  clearPromptTimer();
  const timedOutPromptId = currentPromptId;
  promptTimer = setTimeout(() => {
    logError("Prompt exceeded timeout — cancelling turn", { timeoutMs: PROMPT_TIMEOUT_MS });
    sendOutput(
      `Agent exceeded the ${Math.round(PROMPT_TIMEOUT_MS / 1000)}s budget — sending session/cancel`,
      "stderr"
    );
    writeToKiro({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: acpSessionId } });

    promptTimer = setTimeout(() => {
      if (currentPromptId !== timedOutPromptId) return; // agent answered after all
      finishPromptTurn({
        id: timedOutPromptId,
        error: {
          code: -32000,
          message: `Prompt timed out after ${Math.round(PROMPT_TIMEOUT_MS / 1000)}s and did not respond to session/cancel`,
        },
      });
    }, PROMPT_CANCEL_GRACE_MS);
  }, PROMPT_TIMEOUT_MS);
}

/**
 * Route one parsed JSON-RPC message from kiro-cli.
 * Returns true when the message was consumed, false to fall through to raw output.
 */
function handleAcpMessage(msg) {
  // ── Requests / notifications from the agent ──────────────────────────────
  if (typeof msg.method === "string") {
    const method = msg.method;

    // Session updates: streaming agent messages, thoughts, tool calls, plans.
    // `_kiro.dev/session/update` is the Kiro-specific extension channel.
    if (method === "session/update" || method === "_kiro.dev/session/update") {
      if (msg.params?.update) {
        logSessionUpdate(msg.params.update);
        sendSessionUpdate(msg.params.update);
      }
      if (msg.id !== undefined) writeToKiro({ jsonrpc: "2.0", id: msg.id, result: {} });
      return true;
    }

    // Permission prompt for a tool the agent isn't pre-authorised for.
    if (method === "session/request_permission" && msg.id !== undefined) {
      approvePermission(msg);
      return true;
    }

    // kiro-cli could not resolve `--agent <name>` and silently fell back to its
    // built-in default agent — which has a different prompt and tool set than
    // the one we configured. Never let this pass unnoticed.
    if (method === "_kiro.dev/agent/not_found") {
      logError("kiro-cli could not find the configured agent — falling back to its default agent", {
        agent: AGENT_NAME,
        expectedPath: `${WORKSPACE}/.kiro/agents/${AGENT_NAME}.json`,
        params: msg.params ?? null,
      });
      sendOutput(
        `Agent "${AGENT_NAME}" was not found by kiro-cli (expected ${WORKSPACE}/.kiro/agents/${AGENT_NAME}.json). ` +
          `kiro-cli fell back to its built-in default agent.`,
        "stderr"
      );
      return true;
    }

    // Capture credit/usage data from the end-of-turn metadata notification.
    // kiro-cli emits `_kiro.dev/metadata` with `meteringUsage` after each turn.
    if (method === "_kiro.dev/metadata") {
      const params = msg.params ?? {};
      if (params.meteringUsage?.length) {
        // Sum all credit entries (typically just one)
        let credits = 0;
        for (const entry of params.meteringUsage) {
          if (entry.unit === "credit") credits += entry.value;
        }
        turnStats.credits = credits;
        logInfo("turn-metering", {
          credits,
          unit: params.meteringUsage[0].unit,
          turnDurationMs: params.turnDurationMs,
          contextUsagePercentage: params.contextUsagePercentage,
        });
      }
      return true;
    }

    // We advertise no fs/terminal client capabilities, so these shouldn't
    // arrive — but answer explicitly rather than letting the agent hang.
    if (msg.id !== undefined && (method.startsWith("fs/") || method.startsWith("terminal/"))) {
      logError("Unsupported client capability requested by agent", { method });
      respondError(msg.id, -32601, `Client does not support ${method}`);
      return true;
    }

    if (msg.id !== undefined) {
      logError("Unhandled ACP request from agent — replying method-not-found", { method });
      respondError(msg.id, -32601, `Unhandled method ${method}`);
      return true;
    }

    logInfo("Unhandled ACP notification from agent", { method });
    return true;
  }

  // ── Responses to our requests ────────────────────────────────────────────
  const isResponse = msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined);
  if (!isResponse) return false;

  if (msg.id === INIT_REQUEST_ID) {
    clearReadyTimeout();
    if (msg.error) {
      logError("ACP initialize failed", { error: msg.error });
      sendOutput(`kiro-cli ACP initialize failed: ${JSON.stringify(msg.error)}`, "stderr");
      try { kiroProc?.kill("SIGTERM"); } catch { /* noop */ }
      return true;
    }
    logInfo("ACP initialize complete", {
      protocolVersion: msg.result?.protocolVersion ?? null,
      agent: msg.result?.agentInfo ?? null,
      authMethods: (msg.result?.authMethods || []).map((m) => m.id ?? m),
    });
    sendOutput("kiro-cli ACP initialized — creating session...", "system");

    // Now create the session. Its id is required by session/prompt.
    readyTimeout = setTimeout(() => {
      if (!kiroReady) {
        logError("kiro-cli did not answer session/new within timeout", { timeoutMs: KIRO_READY_TIMEOUT_MS });
        sendOutput(`kiro-cli session/new timed out after ${KIRO_READY_TIMEOUT_MS / 1000}s — killing process`, "stderr");
        try { kiroProc?.kill("SIGTERM"); } catch { /* noop */ }
      }
    }, KIRO_READY_TIMEOUT_MS);

    writeToKiro({
      jsonrpc: "2.0",
      method: "session/new",
      id: NEW_SESSION_REQUEST_ID,
      params: { cwd: WORKSPACE, mcpServers: [] },
    });
    return true;
  }

  if (msg.id === NEW_SESSION_REQUEST_ID) {
    clearReadyTimeout();
    if (msg.error || !msg.result?.sessionId) {
      logError("ACP session/new failed", { error: msg.error ?? "no sessionId in response", result: msg.result });
      sendOutput(
        `kiro-cli session/new failed: ${msg.error ? JSON.stringify(msg.error) : "no sessionId returned"}`,
        "stderr"
      );
      try { kiroProc?.kill("SIGTERM"); } catch { /* noop */ }
      return true;
    }
    acpSessionId = msg.result.sessionId;
    kiroReady = true;
    logInfo("ACP session created — kiro-cli is ready", {
      acpSessionId,
      cwd: WORKSPACE,
      currentModeId: msg.result.modes?.currentModeId ?? null,
    });
    sendOutput(`kiro-cli ACP session ready (session: ${acpSessionId})`, "system");
    drainPromptQueue();
    return true;
  }

  if (currentPromptId !== null && msg.id === currentPromptId) {
    finishPromptTurn(msg);
    return true;
  }

  logInfo("Unmatched ACP response from agent", { id: msg.id, hasError: msg.error !== undefined });
  return true;
}

function spawnKiro() {
  const args = AGENT_NAME ? ["acp", "--agent", AGENT_NAME] : ["acp"];
  const env = { ...process.env, KIRO_API_KEY, NO_COLOR: "1", FORCE_COLOR: "0" };

  sendOutput(AGENT_NAME ? `Starting kiro-cli acp --agent ${AGENT_NAME}` : "Starting kiro-cli acp (no agent)", "system");

  kiroProc = spawn("kiro-cli", args, { stdio: ["pipe", "pipe", "pipe"], env, cwd: WORKSPACE });

  let buffer = "";

  /** Timeout handle for kiro-cli readiness — if ACP handshake doesn't complete, fail fast. */
  clearReadyTimeout();
  readyTimeout = setTimeout(() => {
    if (!kiroReady) {
      logError("kiro-cli did not answer initialize within timeout", { timeoutMs: KIRO_READY_TIMEOUT_MS });
      sendOutput(`kiro-cli failed to initialize within ${KIRO_READY_TIMEOUT_MS / 1000}s — killing process`, "stderr");
      try { kiroProc?.kill("SIGTERM"); } catch { /* noop */ }
    }
  }, KIRO_READY_TIMEOUT_MS);

  kiroProc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        // Non-JSON line on stdout — kiro-cli diagnostics, pass through.
        sendOutput(trimmed, "stdout");
        continue;
      }

      try {
        if (!handleAcpMessage(msg)) {
          // Structured but unrecognised — surface it instead of dropping it.
          logInfo("Unrecognised ACP line", { line: truncate(trimmed, 1000) });
          sendOutput(trimmed, "stdout");
        }
      } catch (err) {
        logError("Error handling ACP message", {
          error: err?.message || String(err),
          line: truncate(trimmed, 1000),
        });
      }
    }
  });

  kiroProc.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) sendOutput(text, "stderr");
  });

  kiroProc.on("exit", (code, signal) => {
    clearReadyTimeout();
    clearPromptTimer();
    logInfo("kiro-cli exited", { code, signal, hadInFlightPrompt: currentPromptId !== null });
    if (currentPromptId !== null) {
      sendOutput(`kiro-cli exited mid-prompt (code: ${code}, signal: ${signal})`, "stderr");
    }
    kiroProc = null;
    kiroReady = false;
    acpSessionId = null;
    // If kiro dies while the session is live, that's the end of the worker.
    commitOnExitAndShutdown(code ?? 0);
  });

  kiroProc.on("error", (err) => {
    clearReadyTimeout();
    logError("Failed to spawn kiro-cli", { error: err?.message || String(err) });
    kiroProc = null;
    kiroReady = false;
    sendOutput(`Failed to start kiro-cli: ${err?.message || String(err)}`, "stderr");
    gracefulShutdown(1);
  });

  // Start the ACP handshake. The session/new call that produces the usable
  // sessionId is issued from handleAcpMessage once initialize returns.
  writeToKiro({
    jsonrpc: "2.0",
    method: "initialize",
    id: INIT_REQUEST_ID,
    params: {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    },
  });
}

function handlePrompt(text, taskMeta) {
  if (!text) return;

  logInfo("Prompt received from orchestrator", {
    taskId: taskMeta?.id ?? null,
    taskTitle: taskMeta?.title ?? null,
    taskType: taskMeta?.type ?? null,
    promptChars: text.length,
    kiroReady,
  });

  // If task metadata is provided and we have a git repo, create a task-specific branch
  if (taskMeta && REPO_URL) {
    currentTaskMeta = taskMeta;
    try {
      currentBranchName = createTaskBranch(taskMeta);
    } catch (err) {
      sendOutput(`Warning: could not create task branch: ${err?.message || err}`, "stderr");
      logError("Failed to create task branch", { error: err?.message || String(err) });
      // Fall back to a session-scoped branch (-B so a retry can't collide).
      currentBranchName = `kirofactory/${SESSION_ID}`;
      try {
        execFileArgs("git", ["checkout", "-B", currentBranchName], { cwd: WORKSPACE });
        sendOutput(`Using fallback branch: ${currentBranchName}`, "stderr");
      } catch (fallbackErr) {
        logError("Fallback branch checkout failed", { error: fallbackErr?.message || String(fallbackErr) });
      }
    }
  }

  if (!kiroReady || !kiroProc) {
    logInfo("kiro-cli not ready yet — queueing prompt", { queueLength: promptQueue.length + 1 });
    promptQueue.push(text);
    return;
  }
  deliverPrompt(text);
}

function drainPromptQueue() {
  while (promptQueue.length > 0 && kiroReady && kiroProc) {
    deliverPrompt(promptQueue.shift());
  }
}

function deliverPrompt(text) {
  if (!kiroProc?.stdin?.writable || !acpSessionId) {
    logInfo("Cannot deliver prompt yet — re-queueing", {
      hasStdin: !!kiroProc?.stdin?.writable,
      hasAcpSession: !!acpSessionId,
    });
    promptQueue.push(text);
    return;
  }

  promptCounter += 1;
  currentPromptId = promptCounter;
  turnStats = { toolCalls: 0, messageChars: 0, thoughtChars: 0, startedAt: Date.now(), credits: 0 };

  const sent = writeToKiro({
    jsonrpc: "2.0",
    method: "session/prompt",
    id: currentPromptId,
    params: { sessionId: acpSessionId, prompt: [{ type: "text", text }] },
  });

  if (!sent) {
    logError("Failed to write session/prompt to kiro-cli");
    finishPromptTurn({
      id: currentPromptId,
      error: { code: -32000, message: "Could not write prompt to kiro-cli stdin" },
    });
    return;
  }

  logInfo("Prompt delivered to kiro-cli", {
    promptId: currentPromptId,
    acpSessionId,
    promptChars: text.length,
    timeoutSeconds: Math.round(PROMPT_TIMEOUT_MS / 1000),
    promptPreview: truncate(text, 500),
  });
  sendOutput(
    `Prompt sent to agent (${text.length} chars, budget ${Math.round(PROMPT_TIMEOUT_MS / 1000)}s)`,
    "system"
  );
  startPromptTimer();
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

function commitOnExitAndShutdown(exitCode) {
  if (shuttingDown) return;
  if (AGENT_KIND !== "inspector") {
    try {
      const result = commitAndPush();
      if (result.pushed) sendOutput(`Changes pushed to ${result.branchName}`, "system");
    } catch (err) {
      logError("commit/push on exit failed", { error: err?.message || String(err) });
      sendOutput(`commit/push failed: ${err?.message || String(err)}`, "stderr");
    }
  }
  // worker-shutdown drives the orchestrator's final session status; the socket
  // close that follows is what signals the disconnect.
  gracefulShutdown(exitCode);
}

function gracefulShutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo("Shutting down", { exitCode });

  if (kiroProc && kiroProc.exitCode === null) {
    try { kiroProc.kill("SIGTERM"); } catch { /* noop */ }
  }

  sendShutdown(exitCode);
  stopHeartbeat();

  // Give the shutdown message a moment to flush, then exit.
  setTimeout(() => {
    try { ws?.close(1000, "worker shutting down"); } catch { /* noop */ }
    process.exit(exitCode);
  }, 1_000);
}

process.on("SIGTERM", () => gracefulShutdown(0));
process.on("SIGINT", () => gracefulShutdown(0));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

connectWithRetry();

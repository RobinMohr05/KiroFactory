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
import { buildGroupPrContent, findSiblingPrUrl } from "./shared-branch-utils.js";

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
/**
 * Base64-encoded `.kiro/agents/<AGENT_NAME>.json` content, built by the
 * orchestrator from the session's DB Agent record (see
 * backend/src/agent/agent-config-writer.ts). Takes precedence over the
 * hardcoded default in ensureAgentConfig() below.
 */
const AGENT_CONFIG_JSON_B64 = process.env.AGENT_CONFIG_JSON_B64;
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
/**
 * Comma-separated list of MCP server names hosted by the per-session MCP
 * proxy sidecar (see backend/src/aca-worker-spawner.ts::startWorkerJob).
 * Each name here must be bridged into kiro-cli's mcpServers via
 * ta-mcp-connect — the sidecar itself is not reachable by kiro-cli directly.
 */
const MCP_SIDECAR_SERVER_NAMES = (process.env.MCP_SIDECAR_SERVER_NAMES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Persistent branch name for standalone (requiresTask=false) sessions.
 * When set, the worker checks out/creates this branch once on startup and
 * commits+pushes to it after each prompt — no task branching, no PR creation.
 */
const PERSISTENT_BRANCH_NAME = process.env.PERSISTENT_BRANCH_NAME || "";

/**
 * Path to a small counter file shared between the verdict and pr-review MCP
 * servers (each spawned as its own child process by kiro-cli, so they can't
 * share in-memory state with each other or with this worker process).
 *
 * pr-review-mcp-server.js increments the file on every successful
 * `post_review_comment` call. verdict-mcp-server.js reads it to refuse a
 * "changes_requested" verdict when zero comments were posted this turn —
 * otherwise a reviewer can report issues that exist nowhere except its own
 * chat transcript, and the task bounces back to "todo" with no way for the
 * next agent to see what needs fixing (see steering notes on task 155).
 *
 * Reset to "0" at the start of every prompt turn in deliverPrompt() — the MCP
 * servers themselves are spawned once per session, not per turn, so nothing
 * else clears it between turns.
 */
const REVIEW_MARKER_PATH = `/tmp/kirofactory-review-comments-${SESSION_ID || "local"}.count`;

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
 * Fetch the latest `DEV_BRANCH` from origin and fast-forward the local ref to
 * match it.
 *
 * Runs before every task's branch decision so a new task branch — or the
 * "does this deterministic branch already exist" probe, or an inspector's
 * `git diff origin/DEV_BRANCH...HEAD` — is always based on the current state
 * of develop, not whatever commit happened to be on develop when the
 * container was cloned at job startup. Without this, a long-running loop that
 * processes many tasks back to back would keep branching new tasks off an
 * increasingly stale snapshot of develop.
 */
function refreshDevBranch() {
  try {
    execFileArgs("git", ["fetch", "origin", DEV_BRANCH], { cwd: WORKSPACE });
    resetWorkingTree();
    execFileArgs("git", ["checkout", DEV_BRANCH], { cwd: WORKSPACE });
    execFileArgs("git", ["reset", "--hard", `origin/${DEV_BRANCH}`], { cwd: WORKSPACE });
    logInfo("Refreshed DEV_BRANCH from origin", { branch: DEV_BRANCH });
    sendOutput(`Refreshed ${DEV_BRANCH} from origin before starting next task.`, "system");
  } catch (err) {
    logError("Failed to refresh DEV_BRANCH from origin — continuing with existing local ref", {
      branch: DEV_BRANCH,
      error: err?.message || String(err),
    });
    sendOutput(
      `Warning: could not refresh ${DEV_BRANCH} from origin (${err?.message || err}) — using existing local state.`,
      "stderr"
    );
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
 * Set up the persistent branch for standalone (requiresTask=false) sessions.
 * If the branch already exists on the remote (crash-recovery), check it out.
 * Otherwise, create it fresh from DEV_BRANCH.
 */
function setupPersistentBranch() {
  if (!PERSISTENT_BRANCH_NAME) return;
  try {
    // Check if the branch exists on the remote
    const remoteRef = execFileArgs(
      "git",
      ["ls-remote", "--heads", authRemoteUrl || "origin", PERSISTENT_BRANCH_NAME],
      { cwd: WORKSPACE }
    );
    if (remoteRef) {
      // Branch exists remotely — fetch and check it out (crash-recovery path)
      execFileArgs("git", ["fetch", authRemoteUrl || "origin", PERSISTENT_BRANCH_NAME], { cwd: WORKSPACE });
      // Use FETCH_HEAD — when fetching from a raw URL (not a remote name),
      // git only updates FETCH_HEAD, not refs/remotes/origin/<branch>.
      execFileArgs("git", ["checkout", "-B", PERSISTENT_BRANCH_NAME, "FETCH_HEAD"], { cwd: WORKSPACE });
      sendOutput(`Checked out existing persistent branch: ${PERSISTENT_BRANCH_NAME}`, "system");
    } else {
      // Branch doesn't exist yet — create fresh from DEV_BRANCH
      execFileArgs("git", ["checkout", "-B", PERSISTENT_BRANCH_NAME, DEV_BRANCH], { cwd: WORKSPACE });
      sendOutput(`Created persistent branch: ${PERSISTENT_BRANCH_NAME} (from ${DEV_BRANCH})`, "system");
    }
  } catch (err) {
    sendOutput(`Warning: persistent branch setup failed: ${err?.message || err}`, "stderr");
    logError("setupPersistentBranch failed", { error: err?.message || String(err), branch: PERSISTENT_BRANCH_NAME });
    // Fall back to staying on DEV_BRANCH — prompt will still work, just won't commit to the right branch
  }
}

/**
 * Sync the persistent branch with remote before a new prompt turn.
 * Fast-forwards the local branch to match the latest remote state so
 * the workspace is always up-to-date when starting a turn.
 */
function syncPersistentBranch() {
  if (!PERSISTENT_BRANCH_NAME) return;
  try {
    execFileArgs("git", ["fetch", authRemoteUrl || "origin", PERSISTENT_BRANCH_NAME], { cwd: WORKSPACE });
    // Reset to FETCH_HEAD — when fetching from a raw URL (not a remote name),
    // git only updates FETCH_HEAD, not refs/remotes/origin/<branch>.
    execFileArgs("git", ["reset", "--hard", "FETCH_HEAD"], { cwd: WORKSPACE });
  } catch {
    // If the remote branch doesn't exist yet (first turn), this is expected
    // — nothing to sync against. Fall through silently.
  }
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
  //
  // --include=dev is explicit, not decorative: npm's `omit` config defaults
  // to 'dev' whenever NODE_ENV=production (or omit=dev is set some other
  // way), which silently skips writing devDependencies to node_modules even
  // though the install exits 0 — they still get resolved into
  // package-lock.json, just never installed. That exact bug (via this
  // Dockerfile's now-removed `ENV NODE_ENV=production`) made vitest and
  // typescript disappear from every agent session's node_modules while every
  // install step reported success. Keep this flag even though the Dockerfile
  // no longer sets NODE_ENV, so a future reintroduction of that env var
  // doesn't silently reopen the same hole.
  sendOutput("Installing dependencies...", "system");
  try {
    if (existsSync(`${WORKSPACE}/package-lock.json`)) {
      exec("npm ci --include=dev", { cwd: WORKSPACE, timeout: 300_000 });
    } else if (existsSync(`${WORKSPACE}/package.json`)) {
      exec("npm install --include=dev", { cwd: WORKSPACE, timeout: 300_000 });
    }
  } catch (err) {
    sendOutput(`Warning: npm install failed: ${err?.message || err}`, "stderr");
    logError("npm install failed", { error: err?.message || String(err) });
  }

  // Persistent branch mode: check out or create the persistent branch.
  // This replaces per-task branching for standalone (requiresTask=false) sessions.
  if (PERSISTENT_BRANCH_NAME) {
    setupPersistentBranch();
  }

  sendOutput(`Workspace ready on branch ${PERSISTENT_BRANCH_NAME || DEV_BRANCH}`, "system");
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

  // Prefer the orchestrator-supplied config (the session's actual DB Agent
  // record — prompt, tools, allowedTools, resources). Only fall back to the
  // hardcoded default below if the orchestrator didn't send one (e.g. an
  // agentless session, or the named agent no longer exists in the DB).
  if (AGENT_CONFIG_JSON_B64) {
    try {
      const decoded = Buffer.from(AGENT_CONFIG_JSON_B64, "base64").toString("utf-8");
      const agentConfig = JSON.parse(decoded);
      writeFileSync(agentFile, JSON.stringify(agentConfig, null, 2), "utf-8");
      logInfo("Wrote orchestrator-supplied agent config to workspace", { path: agentFile });
      sendOutput(`Injected .kiro/agents/${AGENT_NAME}.json from agent configuration`, "system");
      excludeAgentFileFromGit();
      return;
    } catch (err) {
      logError("Failed to decode/write orchestrator-supplied agent config — falling back to default", {
        error: err?.message || String(err),
      });
    }
  }

  // Fallback default agent config: full tool access, no restrictive allowedTools list.
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
  excludeAgentFileFromGit();
}

/**
 * Keep the injected agent config out of `git status` — otherwise it would be
 * committed as part of every task AND would make the "did the agent change
 * anything?" check report a false positive.
 */
function excludeAgentFileFromGit() {
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
  const taskId = currentTaskMeta?.id || TASK_ID || (PERSISTENT_BRANCH_NAME ? AGENT_NAME : "unknown");
  const taskTitle = currentTaskMeta?.title || (PERSISTENT_BRANCH_NAME ? `${AGENT_NAME} update` : `task ${taskId}`);
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
  const pushResult = pushWithRebaseRetry(branchName);
  if (!pushResult.pushed) {
    logError("git push failed", { branchName, error: pushResult.pushError });
    sendOutput(`Push to ${branchName} failed: ${pushResult.pushError}`, "stderr");
    return { pushed: false, hasChanges: true, committed: true, branchName, pushError: pushResult.pushError };
  }

  sendOutput(`Pushed branch ${branchName}`, "system");
  return { pushed: true, hasChanges: true, committed: true, branchName };
}

/**
 * Push HEAD to `refs/heads/<branchName>` on origin, automatically recovering
 * from non-fast-forward rejections.
 *
 * A non-fast-forward rejection means the remote branch moved after this
 * container checked it out — e.g. the same task being reworked across
 * multiple runs (editor -> reviewer comments -> editor again) or a shared
 * branch (see task #163) being pushed to from a different run in between
 * this container's checkout and its push. That is a recoverable race, NOT a
 * credential/permission problem. The caller upstream (session-manager.ts)
 * treats any push failure after a successful commit as `deliveryFailed` and
 * permanently blocks the task for the rest of the session on the assumption
 * that retrying can't help — which is only true for real auth/permission
 * errors. Retrying blindly would fail identically forever, so on a detected
 * non-fast-forward rejection we fetch the branch, rebase our new commit on
 * top of the fetched tip, and retry the push here — before the failure ever
 * reaches that "credential problem" classification.
 *
 * A genuine auth/permission error (bad PAT, no write access, unknown host)
 * produces a completely different git error and is returned immediately
 * without retrying, so it still surfaces (and blocks) as the real problem it
 * is.
 */
function pushWithRebaseRetry(branchName, maxAttempts = 3) {
  const remote = authRemoteUrl || "origin";
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      execFileArgs("git", ["push", remote, `HEAD:refs/heads/${branchName}`], { cwd: WORKSPACE });
      return { pushed: true };
    } catch (err) {
      const pushError = redactSecrets(err?.message || String(err));
      lastError = pushError;

      const isNonFastForward = /\[rejected\]|non-fast-forward|fetch first|behind its remote/i.test(pushError);
      if (!isNonFastForward || attempt === maxAttempts) {
        return { pushed: false, pushError };
      }

      sendOutput(
        `Push to ${branchName} rejected (non-fast-forward, attempt ${attempt}/${maxAttempts}) — ` +
          `remote moved since checkout. Fetching and rebasing before retry...`,
        "system"
      );
      logInfo("Non-fast-forward push rejected — rebasing onto remote and retrying", { branchName, attempt });

      try {
        execFileArgs("git", ["fetch", remote, branchName], { cwd: WORKSPACE });
        // FETCH_HEAD, not refs/remotes/origin/<branch> — fetching from a raw
        // authenticated URL (not the "origin" remote name) only updates
        // FETCH_HEAD (same reasoning as syncPersistentBranch() above).
        execFileArgs("git", ["rebase", "FETCH_HEAD"], { cwd: WORKSPACE });
      } catch (rebaseErr) {
        // A real conflict (or fetch failure) needs a human/agent to resolve,
        // not a blind retry — abort so the workspace isn't left mid-rebase,
        // and surface both errors together for diagnosis.
        try {
          execFileArgs("git", ["rebase", "--abort"], { cwd: WORKSPACE });
        } catch { /* no rebase in progress */ }
        const rebaseError = redactSecrets(rebaseErr?.message || String(rebaseErr));
        logError("Rebase onto remote failed after non-fast-forward push rejection", {
          branchName,
          attempt,
          error: rebaseError,
        });
        return { pushed: false, pushError: `${pushError}\n\nRebase retry also failed: ${rebaseError}` };
      }
    }
  }

  return { pushed: false, pushError: lastError };
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

  // If sibling tasks are provided (shared branch group), generate a grouped PR
  const siblings = currentTaskMeta?.siblingTasks;
  if (siblings && siblings.length > 0) {
    return buildGroupPrContent(
      { id: taskId, title: taskTitle, type: taskType, description: taskDescription },
      siblings
    );
  }

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

/** Fetch an existing open GitHub PR for the given branch, or null if none. */
async function fetchExistingGitHubPullRequest(owner, repo, branchName) {
  try {
    // GitHub expects head in "owner:branch" form for cross-fork queries;
    // for same-repo PRs either form works but the colon form is unambiguous.
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branchName)}&per_page=1`;
    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${GITHUB_PAT}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return Array.isArray(data) && data.length > 0 ? data[0].html_url : null;
  } catch {
    return null;
  }
}

/**
 * Update an existing GitHub PR's title and body.
 * Used to add references to newly-completed sibling tasks in a shared branch group.
 *
 * @param {string} prUrl The full PR URL (e.g. https://github.com/owner/repo/pull/123)
 * @param {string} title New PR title
 * @param {string} body New PR body
 */
async function updateGitHubPullRequest(prUrl, title, body) {
  if (!GITHUB_PAT) return;

  // Parse PR number from URL: https://github.com/owner/repo/pull/123
  const prMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!prMatch) {
    logError("Cannot parse PR URL for update", { url: prUrl });
    return;
  }
  const [, owner, repo, prNumber] = prMatch;

  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${GITHUB_PAT}`,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ title, body }),
      }
    );

    if (response.ok) {
      sendOutput(`PR #${prNumber} updated with grouped task references`, "system");
      logInfo("Updated GitHub PR body for shared branch group", { prNumber, prUrl });
    } else {
      const errorData = await response.json().catch(() => ({}));
      logError("GitHub PR update failed", {
        status: response.status,
        error: errorData.message || `HTTP ${response.status}`,
      });
    }
  } catch (err) {
    logError("GitHub PR update network error", { error: err?.message || String(err) });
  }
}

/**
 * Update an existing Azure DevOps PR's title and description.
 * Used to add references to newly-completed sibling tasks in a shared branch group.
 *
 * @param {string} prUrl The full PR URL
 * @param {string} title New PR title
 * @param {string} description New PR description
 */
async function updateAzureDevOpsPullRequest(prUrl, title, description) {
  if (!AZURE_DEVOPS_PAT) return;

  const parsed = parseAzureDevOpsUrl(REPO_URL);
  if (!parsed) return;

  // Extract PR ID from the URL (e.g. .../pullrequest/42)
  const prIdMatch = prUrl.match(/pullrequest\/(\d+)/);
  if (!prIdMatch) {
    logError("Cannot parse PR ID from Azure DevOps URL for update", { url: prUrl });
    return;
  }
  const prId = prIdMatch[1];

  const { org, project, repo } = parsed;
  // Azure DevOps caps the PR description at 4000 characters.
  const truncatedDesc = description.length > 4000 ? `${description.slice(0, 3990)}\n…` : description;

  const apiUrl =
    `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}` +
    `/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}?api-version=7.1`;

  try {
    const response = await fetch(apiUrl, {
      method: "PATCH",
      headers: {
        "Authorization": `Basic ${Buffer.from(`:${AZURE_DEVOPS_PAT}`).toString("base64")}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ title, description: truncatedDesc }),
    });

    if (response.ok) {
      sendOutput(`PR updated with grouped task references`, "system");
      logInfo("Updated Azure DevOps PR body for shared branch group", { prId, prUrl });
    } else {
      const errorData = await response.json().catch(() => ({}));
      logError("Azure DevOps PR update failed", {
        status: response.status,
        error: errorData.message || `HTTP ${response.status}`,
      });
    }
  } catch (err) {
    logError("Azure DevOps PR update network error", { error: err?.message || String(err) });
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

    // GitHub returns 422 "Validation Failed" when a PR for this branch already
    // exists. Rather than failing and leaving prUrl null in the DB (which causes
    // the code-reviewer to get no PR link and report changes_requested, sending
    // the task back to todo in an infinite loop), fetch the existing PR URL.
    if (response.status === 422) {
      const existingUrl = await fetchExistingGitHubPullRequest(owner, repo, branchName);
      if (existingUrl) {
        sendOutput(`PR already exists: ${existingUrl}`, "system");
        logInfo("Using existing GitHub PR", { url: existingUrl, branch: branchName });
        // If this is a grouped task (has siblings), update the existing PR's
        // title and body to reference all tasks in the group (AC5).
        if (currentTaskMeta?.siblingTasks?.length > 0) {
          await updateGitHubPullRequest(existingUrl, title, body);
        }
        return existingUrl;
      }
    }

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

/**
 * Fetch an existing active Azure DevOps PR for the given branch, or null if none.
 * Used as a recovery path when PR creation returns 409 (conflict — PR already exists).
 */
async function fetchExistingAzureDevOpsPullRequest(org, project, repo, branchName) {
  if (!AZURE_DEVOPS_PAT) return null;

  const apiUrl =
    `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}` +
    `/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests` +
    `?searchCriteria.sourceRefName=refs/heads/${encodeURIComponent(branchName)}` +
    `&searchCriteria.status=active&$top=1&api-version=7.1`;

  try {
    const response = await fetch(apiUrl, {
      headers: {
        "Authorization": `Basic ${Buffer.from(`:${AZURE_DEVOPS_PAT}`).toString("base64")}`,
        "Accept": "application/json",
      },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const prs = data?.value;
    if (Array.isArray(prs) && prs.length > 0) {
      const pr = prs[0];
      return pr?._links?.web?.href ||
        (pr?.repository?.webUrl && pr?.pullRequestId
          ? `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`
          : null);
    }
    return null;
  } catch {
    return null;
  }
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

    // Azure DevOps returns 409 Conflict when a PR for this branch already
    // exists. Mirror the GitHub 422 recovery: fetch the existing PR URL
    // instead of failing and leaving prUrl null in the DB.
    if (response.status === 409) {
      const existingUrl = await fetchExistingAzureDevOpsPullRequest(org, project, repo, branchName);
      if (existingUrl) {
        sendOutput(`PR already exists: ${existingUrl}`, "system");
        logInfo("Using existing Azure DevOps PR", { url: existingUrl, branch: branchName });
        // If this is a grouped task (has siblings), update the existing PR's
        // title and body to reference all tasks in the group (AC5).
        if (currentTaskMeta?.siblingTasks?.length > 0) {
          await updateAzureDevOpsPullRequest(existingUrl, title, description);
        }
        return existingUrl;
      }
    }

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
/**
 * Resolver/rejecter for an in-flight session/new request. Used both for the
 * initial handshake (right after initialize) and for every later per-task
 * session refresh — see createNewAcpSession().
 */
let sessionNewResolve = null;
let sessionNewReject = null;
/** Handle for the readiness timeout (module scope so message handlers can clear it). */
let readyTimeout = null;
/** Handle for the in-flight prompt timeout. */
let promptTimer = null;
/** Counters for the current turn, reported alongside prompt-done. */
let turnStats = { toolCalls: 0, messageChars: 0, thoughtChars: 0, startedAt: 0, credits: 0 };
/**
 * Verdict reported by the agent via the report_verdict MCP tool this turn.
 * null means no verdict was reported (normal flow).
 */
let turnVerdict = null; // { verdict: "resolved"|"no_action_needed", reason: string } | null
/** Tracks toolCallId → tool name for verdict detection across tool_call/tool_call_update. */
let verdictToolCallId = null;
/**
 * MCP servers that kiro-cli reported as failing to initialize for the current
 * ACP session (one entry per `_kiro.dev/mcp/server_init_failure` notification).
 * Reset on every fresh session/new (see createNewAcpSession()) — a session is
 * created fresh per claimed task, so this always reflects the current turn.
 *
 * Populated with whatever kiro-cli sends us (server name if present, raw
 * params otherwise) — the exact shape of this notification isn't part of the
 * public ACP schema, so we don't assume specific field names beyond a
 * best-effort attempt at a name.
 */
let mcpServerInitFailures = [];

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

/**
 * Issue a fresh session/new against the already-running kiro-cli process.
 *
 * Used both for the initial handshake (right after initialize) and — this is
 * the important part — again before every claimed task, so each task starts
 * with zero conversation history instead of inheriting whatever the previous
 * task's turn accumulated. kiro-cli scopes all state to sessionId, so a new
 * session/new on the same process is enough to get a clean context; no
 * process respawn (and no re-running `initialize`) is needed.
 *
 * buildMcpServers() is called fresh each time too, which means a session
 * created for an inspector task picks up that task's current TASK_PR_URL —
 * so a rework pass reads the PR's actual review comments through the
 * pr-review MCP tool instead of relying on anything from a prior turn.
 *
 * Resolves with the new sessionId, or rejects if kiro-cli returns an error
 * or the request times out.
 */
function createNewAcpSession() {
  return new Promise((resolve, reject) => {
    if (sessionNewResolve || sessionNewReject) {
      reject(new Error("A session/new request is already in flight"));
      return;
    }

    // Reset per-session MCP failure tracking — this session's server_init_*
    // notifications (fired shortly after session/new resolves) should only
    // ever reflect servers spawned for THIS session, not a stale one.
    mcpServerInitFailures = [];

    clearReadyTimeout();
    readyTimeout = setTimeout(() => {
      sessionNewResolve = null;
      sessionNewReject = null;
      reject(new Error(`session/new timed out after ${KIRO_READY_TIMEOUT_MS / 1000}s`));
    }, KIRO_READY_TIMEOUT_MS);

    sessionNewResolve = (sessionId) => {
      clearReadyTimeout();
      resolve(sessionId);
    };
    sessionNewReject = (err) => {
      clearReadyTimeout();
      reject(err);
    };

    const sent = writeToKiro({
      jsonrpc: "2.0",
      method: "session/new",
      id: NEW_SESSION_REQUEST_ID,
      params: {
        cwd: WORKSPACE,
        mcpServers: buildMcpServers(),
      },
    });

    if (!sent) {
      clearReadyTimeout();
      sessionNewResolve = null;
      sessionNewReject = null;
      reject(new Error("Could not write session/new to kiro-cli stdin"));
    }
  });
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
 *   - { Json: { content: [{ type: "text", text: "..." }] } } (MCP tool results)
 *   - { Json: { exit_status: "...", stdout: "...", stderr: "..." } } (shell results)
 * This handles all of them defensively rather than assuming one shape.
 */
function extractToolOutputText(update) {
  const parts = [];

  const content = Array.isArray(update?.content) ? update.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;

    // Direct text block: { type: "text", text: "..." } or { content: { text: "..." } }
    const directText = block.text ?? block.content?.text;
    if (typeof directText === "string" && directText) {
      parts.push(directText);
      continue;
    }

    // MCP tool result block: { Json: { content: [{ type: "text", text: "..." }] } }
    if (block.Json && typeof block.Json === "object") {
      const jsonBlock = block.Json;
      // MCP text content array
      if (Array.isArray(jsonBlock.content)) {
        for (const inner of jsonBlock.content) {
          if (inner?.type === "text" && typeof inner.text === "string" && inner.text) {
            parts.push(inner.text);
          }
        }
      }
      // Shell-style result: { exit_status, stdout, stderr }
      if (typeof jsonBlock.stdout === "string" && jsonBlock.stdout) {
        parts.push(jsonBlock.stdout);
      }
      if (typeof jsonBlock.stderr === "string" && jsonBlock.stderr) {
        parts.push(jsonBlock.stderr);
      }
      continue;
    }

    if (block.type === "diff" && block.path) {
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
      // Track if this is a report_verdict call so we can capture the verdict from the update.
      // kiro-cli reports MCP tool titles as "Running: @<server>/<tool>" (e.g.
      // "Running: @verdict/report_verdict"), never the bare tool name — an exact
      // match against "report_verdict" never fires. Match by substring instead.
      if (
        (typeof update.title === "string" && update.title.includes("report_verdict")) ||
        (typeof update.kind === "string" && update.kind.includes("report_verdict"))
      ) {
        verdictToolCallId = update.toolCallId ?? null;
      }
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
      // Capture verdict from the report_verdict tool's completed output.
      //
      // Two detection strategies, tried in order:
      //
      // 1. toolCallId-matched: we saw the tool_call announcement first, stored
      //    its toolCallId in verdictToolCallId, and can now match the update.
      //
      // 2. Content-based fallback: kiro-cli sometimes sends tool_call_update
      //    before tool_call (or the title match above missed it). Scan every
      //    completed tool_call_update output for the verdict JSON shape
      //    {"verdict": "..."} regardless of which tool produced it. The
      //    verdict-mcp-server is the only tool that emits this shape, so false
      //    positives are not a real concern.
      const isVerdictUpdate =
        (verdictToolCallId && update.toolCallId === verdictToolCallId && update.status === "completed") ||
        (update.status === "completed" && outputText && outputText.includes('"verdict"'));

      if (isVerdictUpdate && outputText) {
        // The verdict JSON is always {"verdict":"...","reason":"..."}.
        // It may arrive:
        //  a) as the direct outputText (already extracted from content[].text)
        //  b) wrapped in an ACP items envelope: {"items":[{"Json":{"content":[{"type":"text","text":"{...}"}]}}]}
        //     — this happens for MCP tool results where rawOutput carries the full envelope
        //     and extractToolOutputText returns it verbatim because content[] is empty.
        // Try direct parse first, then unwrap the envelope.
        function tryParseVerdict(str) {
          if (!str || typeof str !== "string") return null;
          try {
            const parsed = JSON.parse(str);
            if (parsed && typeof parsed.verdict === "string") return parsed;
            // Unwrap ACP items envelope: {items:[{Json:{content:[{type:"text",text:"..."}]}}]}
            if (Array.isArray(parsed.items)) {
              for (const item of parsed.items) {
                const inner = item?.Json?.content;
                if (Array.isArray(inner)) {
                  for (const block of inner) {
                    if (block?.type === "text" && typeof block.text === "string") {
                      const inner2 = tryParseVerdict(block.text);
                      if (inner2) return inner2;
                    }
                  }
                }
              }
            }
          } catch { /* not JSON */ }
          return null;
        }

        let captured = tryParseVerdict(outputText);
        if (!captured) {
          // Last-resort regex: find {"verdict":"...",...} anywhere in the string
          const jsonMatch = outputText.match(/\{"verdict"\s*:\s*"[^"]+[^}]*\}/);
          if (jsonMatch) captured = tryParseVerdict(jsonMatch[0]);
        }
        if (captured) {
          turnVerdict = { verdict: captured.verdict, reason: captured.reason || "" };
          logInfo("verdict-captured", { verdict: turnVerdict.verdict, reason: turnVerdict.reason });
        }
        verdictToolCallId = null;
      }
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
 * Build the `mcpServers` array passed to kiro-cli's `session/new`.
 *
 * Always includes the hardcoded "verdict" server. If the orchestrator started
 * an MCP proxy sidecar for this session (MCP_SIDECAR_SERVER_NAMES non-empty),
 * one entry per sidecar server name is added too, each using ta-mcp-connect
 * to bridge stdio ↔ the proxy's TCP endpoint (MCP_PROXY_HOST:MCP_PROXY_PORT).
 * Without this, every proxy-hosted server (atlassian, azure-devops, aws-api,
 * aws-docs, session-level custom servers) is silently unreachable by kiro-cli
 * even though the sidecar container is running and correctly configured.
 */
function buildMcpServers() {
  const servers = [
    {
      // `env` is required by kiro-cli's ACP schema (untagged enum match
      // fails silently without it — the whole session/new request gets
      // rejected as a parse error and kiro-cli exits immediately).
      name: "verdict",
      command: "node",
      args: ["/app/verdict-mcp-server.js"],
      // REVIEW_MARKER_PATH lets the verdict server refuse a "changes_requested"
      // verdict when no post_review_comment call happened this turn (see
      // pr-review-mcp-server.js and the comment on REVIEW_MARKER_PATH above).
      // Harmless for editor-kind sessions, which never report that verdict.
      env: [{ name: "REVIEW_MARKER_PATH", value: REVIEW_MARKER_PATH }],
    },
  ];

  // Include the pr-review MCP server for EVERY session that has a repo to
  // work against, not just inspector-kind agents.
  //
  // This used to be inspector-only, which silently broke the developer
  // agent's rework passes: buildDevPrompt/buildTddDevPrompt explicitly
  // instruct it to call `get_pr_review_comments` as its first action when
  // resuming a task with an open PR (see prompt-builder.ts), and
  // developer-agent.json lists that tool in its `tools` array — but the tool
  // was never actually registered for editor-kind (AGENT_KIND=editor)
  // sessions. In production this meant the agent tried to improvise with
  // shell commands instead (`gh pr view`, `gh api ...`), which always failed
  // because the `gh` CLI isn't installed in this container — so no rework
  // pass ever actually saw its reviewer's feedback.
  //
  // Editor-kind sessions get ALLOW_POST_COMMENT=false: they may read PR
  // comments to fix them, but only inspector-kind agents (code review, QA)
  // are allowed to post comments — see pr-review-mcp-server.js.
  //
  // The server reads REPO_URL, GIT_PROVIDER, credentials, TASK_PR_URL, and
  // DEV_BRANCH from its environment. All except TASK_PR_URL are inherited
  // from the worker's process.env; TASK_PR_URL is set in handlePrompt() when
  // the task's pullRequestUrl is received from the orchestrator. The MCP
  // server should read it at tool-call time, not at module load, because the
  // PR URL is only known after a task is claimed.
  if (REPO_URL) {
    const prReviewEnv = [
      { name: "REPO_URL", value: REPO_URL || "" },
      { name: "GIT_PROVIDER", value: GIT_PROVIDER },
      { name: "DEV_BRANCH", value: DEV_BRANCH || "" },
      { name: "REVIEW_MARKER_PATH", value: REVIEW_MARKER_PATH },
      { name: "ALLOW_POST_COMMENT", value: AGENT_KIND === "inspector" ? "true" : "false" },
      // Inverse of ALLOW_POST_COMMENT: the developer (editor-kind) resolves
      // comments once it has actually fixed the underlying issue in code;
      // the reviewer (inspector-kind) only posts findings, it never resolves
      // its own or anyone else's.
      { name: "ALLOW_RESOLVE_COMMENT", value: AGENT_KIND === "inspector" ? "false" : "true" },
    ];
    if (process.env.GITHUB_PAT) {
      prReviewEnv.push({ name: "GITHUB_PAT", value: process.env.GITHUB_PAT });
    }
    if (AZURE_DEVOPS_PAT) {
      prReviewEnv.push({ name: "AZURE_DEVOPS_PAT", value: AZURE_DEVOPS_PAT });
    }
    // TASK_PR_URL may be empty at session creation — the MCP server handles
    // this gracefully (returns an error to the agent if no PR URL is set).
    // It will be populated in process.env when handlePrompt() receives taskMeta.
    if (process.env.TASK_PR_URL) {
      prReviewEnv.push({ name: "TASK_PR_URL", value: process.env.TASK_PR_URL });
    }
    servers.push({
      name: "pr-review",
      command: "node",
      args: ["/app/pr-review-mcp-server.js"],
      env: prReviewEnv,
    });
    logInfo("Including pr-review MCP server", {
      agentKind: AGENT_KIND,
      allowPostComment: AGENT_KIND === "inspector",
    });
  }

  // Include the pr-complete MCP server for inspector-kind sessions where
  // auto-merge is enabled. The tool merges the PR and deletes the source
  // branch — called explicitly by the QA agent after verifying code quality.
  // Only injected for the qa-improvement-agent (final pipeline stage) to prevent
  // the code-reviewer-agent from merging PRs before QA has run.
  if (AGENT_KIND === "inspector" && process.env.AUTO_MERGE_ENABLED === "true" && AGENT_NAME === "qa-improvement-agent") {
    const prCompleteEnv = [
      { name: "PR_URL", value: process.env.TASK_PR_URL || "" },
      { name: "PR_BRANCH", value: process.env.PR_BRANCH || "" },
      { name: "REPO_URL", value: REPO_URL || "" },
      { name: "ALL_GROUP_TASKS_DONE", value: process.env.ALL_GROUP_TASKS_DONE || "true" },
    ];
    if (process.env.GITHUB_PAT) {
      prCompleteEnv.push({ name: "GITHUB_PAT", value: process.env.GITHUB_PAT });
    }
    if (AZURE_DEVOPS_PAT) {
      prCompleteEnv.push({ name: "AZURE_DEVOPS_PAT", value: AZURE_DEVOPS_PAT });
    }
    servers.push({
      name: "pr-complete",
      command: "node",
      args: ["/app/pr-complete-mcp-server.js"],
      env: prCompleteEnv,
    });
    logInfo("Including pr-complete MCP server", {
      prUrl: process.env.TASK_PR_URL || "(not yet set)",
      prBranch: process.env.PR_BRANCH || "(not yet set)",
      allGroupTasksDone: process.env.ALL_GROUP_TASKS_DONE || "true",
    });
  }

  for (const name of MCP_SIDECAR_SERVER_NAMES) {
    servers.push({
      name,
      command: "/app/ta-mcp-connect",
      args: [name],
      env: [],
    });
  }

  if (MCP_SIDECAR_SERVER_NAMES.length > 0) {
    logInfo("Bridging MCP proxy sidecar servers into kiro-cli", {
      servers: MCP_SIDECAR_SERVER_NAMES,
    });
  }

  return servers;
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
    let effectiveVerdict = turnVerdict; // may be nulled if cross-check fails

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
      // Editor-kind: cross-check verdict, then commit/push/PR flow.

      // Cross-check: if the agent reported "no_action_needed" but the workspace
      // actually has uncommitted changes, that's a contradiction — fall back to
      // the normal commit/push pipeline as if no verdict had been reported.
      if (effectiveVerdict && effectiveVerdict.verdict === "no_action_needed") {
        try {
          const status = exec("git status --porcelain", { cwd: WORKSPACE });
          if (status) {
            const changedFiles = status.split("\n").filter(Boolean);
            logError("Verdict cross-check failed: agent reported no_action_needed but workspace has changes — ignoring verdict", {
              verdict: effectiveVerdict,
              fileCount: changedFiles.length,
              files: changedFiles.slice(0, 20),
            });
            sendOutput(
              `⚠ Agent reported "no_action_needed" but the workspace has ${changedFiles.length} changed file(s) — ` +
              `verdict ignored, proceeding with normal commit/push flow.`,
              "stderr"
            );
            effectiveVerdict = null; // Discard the contradictory verdict
          }
        } catch {
          // git status failed — can't verify, fall through to normal flow
          effectiveVerdict = null;
        }
      }

      try {
        const gitResult = commitAndPush();
        hasChanges = gitResult.hasChanges;
        committed = !!gitResult.committed;
        if (gitResult.pushError) gitError = gitResult.pushError;
        if (gitResult.pushed && gitResult.branchName && !PERSISTENT_BRANCH_NAME) {
          // If a PR URL is already known (shared branch group — sibling already
          // created the PR), skip PR creation (the push already updated the PR's
          // branch automatically). Instead, update the PR title/body to include
          // all tasks in the group (AC5).
          // Check both the current task's own pullRequestUrl AND sibling PR URLs,
          // because the second+ task in a group won't have its own PR URL persisted.
          const groupPrUrl = currentTaskMeta?.pullRequestUrl
            || (currentTaskMeta?.siblingTasks?.length > 0 ? findSiblingPrUrl(currentTaskMeta.siblingTasks) : null);
          if (groupPrUrl && currentTaskMeta?.siblingTasks?.length > 0) {
            prUrl = groupPrUrl;
            const { title, body } = buildPrContent();
            const provider = detectGitProvider(REPO_URL);
            if (provider === "github") {
              await updateGitHubPullRequest(prUrl, title, body);
            } else if (provider === "azure-devops") {
              await updateAzureDevOpsPullRequest(prUrl, title, body);
            }
            sendOutput(`PR already exists (shared branch): ${prUrl}`, "system");
          } else {
            prUrl = await createPullRequest(gitResult.branchName);
          }
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
      verdict: effectiveVerdict ? effectiveVerdict.verdict : undefined,
      // Surface any MCP server that failed to init this turn so the
      // orchestrator can distrust a verdict that depended on a tool the agent
      // never actually had (see mcpServerInitFailures declaration above).
      mcpServerInitFailures: mcpServerInitFailures.length > 0 ? mcpServerInitFailures : undefined,
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

    // kiro-cli failed to start one of the MCP servers we requested in
    // session/new (see buildMcpServers()). Previously this was silently
    // dropped into the generic "Unhandled ACP notification" logger *without*
    // its params, so a failure here was completely undiagnosable — all the
    // log ever showed was the bare method name. Log params in full and record
    // the failure so finishPromptTurn() can flag it in the prompt-done result
    // instead of letting the agent silently lose access to that server's
    // tools (e.g. an inspector losing post_review_comment and falling back to
    // a false "no_action_needed" — see the code-reviewer-agent 403 incidents).
    if (method === "_kiro.dev/mcp/server_init_failure") {
      const params = msg.params ?? {};
      const serverName = params.name || params.server || params.serverName || null;
      logError("MCP server failed to initialize", { params });
      sendOutput(
        `⚠ MCP server${serverName ? ` "${serverName}"` : ""} failed to initialize — ` +
          `its tools will be unavailable this turn. Details: ${JSON.stringify(params)}`,
        "stderr"
      );
      mcpServerInitFailures.push({ name: serverName, params });
      return true;
    }

    if (method === "_kiro.dev/mcp/server_initialized") {
      logInfo("MCP server initialized", { params: msg.params ?? null });
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

    // Create the initial session. Its id is required by session/prompt.
    // Later, each claimed task gets its own fresh session via the same
    // createNewAcpSession() helper — see handlePrompt().
    createNewAcpSession().then(
      () => drainPromptQueue(),
      (err) => {
        const message = err?.message || String(err);
        logError("Initial session/new failed", { error: message });
        sendOutput(`kiro-cli session/new failed: ${message} — killing process`, "stderr");
        try { kiroProc?.kill("SIGTERM"); } catch { /* noop */ }
      }
    );
    return true;
  }

  if (msg.id === NEW_SESSION_REQUEST_ID) {
    clearReadyTimeout();
    const resolve = sessionNewResolve;
    const reject = sessionNewReject;
    sessionNewResolve = null;
    sessionNewReject = null;

    if (msg.error || !msg.result?.sessionId) {
      const errMsg = msg.error ? JSON.stringify(msg.error) : "no sessionId returned";
      logError("ACP session/new failed", { error: msg.error ?? "no sessionId in response", result: msg.result });
      sendOutput(`kiro-cli session/new failed: ${errMsg}`, "stderr");
      if (reject) {
        reject(new Error(`session/new failed: ${errMsg}`));
      } else {
        // Only the very first (startup) session/new has no rejecter attached —
        // there's nothing recoverable to do without a session, so give up.
        try { kiroProc?.kill("SIGTERM"); } catch { /* noop */ }
      }
      return true;
    }

    const isFirstSession = acpSessionId === null;
    acpSessionId = msg.result.sessionId;
    kiroReady = true;
    logInfo(isFirstSession ? "ACP session created — kiro-cli is ready" : "ACP session refreshed for new task", {
      acpSessionId,
      cwd: WORKSPACE,
      currentModeId: msg.result.modes?.currentModeId ?? null,
    });
    sendOutput(
      isFirstSession
        ? `kiro-cli ACP session ready (session: ${acpSessionId})`
        : `Fresh ACP session started for next task (session: ${acpSessionId})`,
      "system"
    );

    if (resolve) {
      resolve(acpSessionId);
    } else {
      // Startup path — no caller awaiting a promise, just drain anything queued.
      drainPromptQueue();
    }
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

  // Persistent branch mode: sync with remote before each prompt, skip task branching
  if (PERSISTENT_BRANCH_NAME && REPO_URL) {
    syncPersistentBranch();
    currentBranchName = PERSISTENT_BRANCH_NAME;
    currentTaskMeta = null;
  } else if (taskMeta && REPO_URL) {
    // If task metadata is provided and we have a git repo, create a task-specific branch
    currentTaskMeta = taskMeta;

    // Clear stale values from any previous task — never leak a prior task's PR/branch
    // to the pr-complete MCP server (risk: merging the wrong PR if the current task
    // lacks a pullRequestUrl or branch for any reason).
    process.env.TASK_PR_URL = "";
    process.env.PR_BRANCH = "";

    // Make the task's PR URL available in process.env for child processes
    // (e.g. the pr-review MCP server reads it at tool-call time).
    if (taskMeta.pullRequestUrl) {
      process.env.TASK_PR_URL = taskMeta.pullRequestUrl;
    }

    // Make auto-merge settings available for buildMcpServers() — the
    // pr-complete MCP server is only included when both the agent is an
    // inspector AND the tab has autoMergePrs enabled.
    process.env.AUTO_MERGE_ENABLED = (taskMeta.autoMergePrs && AGENT_KIND === "inspector") ? "true" : "false";
    process.env.ALL_GROUP_TASKS_DONE = taskMeta.allGroupTasksDone !== false ? "true" : "false";
    // PR_BRANCH for the pr-complete MCP server (the branch to delete after merge)
    if (taskMeta.branch) {
      process.env.PR_BRANCH = taskMeta.branch;
    }

    // Always re-fetch DEV_BRANCH from origin before deciding what to branch
    // from — every task should see the current state of develop, not the
    // snapshot that was cloned when this container started.
    refreshDevBranch();

    try {
      if (AGENT_KIND === "editor") {
        // Editor-kind agents handle their own branch management via prompt
        // instructions (BRANCH SETUP section in buildDevPrompt). The worker
        // just ensures all remote refs are available and sets currentBranchName
        // so commitAndPush() knows where to push after the prompt finishes.
        // The agent is expected to leave the working tree on the correct branch.
        // Fetch all refs and update refs/remotes/origin/* tracking refs.
        // Using "origin" (not authRemoteUrl) ensures tracking refs are updated —
        // fetching from a raw URL only updates FETCH_HEAD. The origin remote URL
        // is the unauthenticated REPO_URL set during clone; for public repos this
        // is sufficient for reads. If auth is needed for reads, set-url origin to
        // authRemoteUrl temporarily — but for KiroFactory's supported cases (public
        // GitHub repos), unauthenticated fetch works fine.
        execFileArgs("git", ["fetch", "origin"], { cwd: WORKSPACE });

        if (taskMeta.branch) {
          currentBranchName = taskMeta.branch;
        } else {
          // Compute the deterministic branch name so commitAndPush() has
          // a target, and the agent prompt receives it via taskMeta.branch
          // (which the orchestrator sends). If taskMeta.branch is empty, the
          // prompt's BRANCH SETUP section won't render — the agent won't know
          // to create a branch. Set currentBranchName to the deterministic name
          // here so the post-prompt push still targets the right ref.
          currentBranchName = buildBranchName(taskMeta.type || "task", taskMeta.id, taskMeta.title);
        }
        sendOutput(
          `Editor agent will manage branch: ${currentBranchName} (worker stays on ${DEV_BRANCH})`,
          "system"
        );
        logInfo("Editor-kind: skipping branch checkout — agent handles branch setup", {
          branch: currentBranchName,
          taskId: taskMeta.id,
        });
      } else {
        // Inspector-kind: checkout the task branch as before (they need to be
        // on it for git diff). This is the unchanged original logic.
        if (taskMeta.branch) {
          resetWorkingTree();
          execFileArgs("git", ["fetch", authRemoteUrl || "origin", taskMeta.branch], { cwd: WORKSPACE });
          execFileArgs("git", ["checkout", "-B", taskMeta.branch, "FETCH_HEAD"], { cwd: WORKSPACE });
          currentBranchName = taskMeta.branch;
          sendOutput(`Checked out existing branch: ${taskMeta.branch} (reset to origin's latest)`, "system");
        } else {
          const deterministicBranch = buildBranchName(taskMeta.type || "task", taskMeta.id, taskMeta.title);
          const remoteRef = execFileArgs(
            "git",
            ["ls-remote", "--heads", authRemoteUrl || "origin", deterministicBranch],
            { cwd: WORKSPACE }
          );

          if (remoteRef) {
            resetWorkingTree();
            execFileArgs("git", ["fetch", authRemoteUrl || "origin", deterministicBranch], { cwd: WORKSPACE });
            execFileArgs("git", ["checkout", "-B", deterministicBranch, "FETCH_HEAD"], { cwd: WORKSPACE });
            currentBranchName = deterministicBranch;
            sendOutput(
              `Task had no branch on record, but ${deterministicBranch} already exists on the remote — ` +
              `checked it out instead of creating a fresh one (recovered from a stale/lost DB branch pointer).`,
              "system"
            );
            logInfo("Recovered existing remote branch for task with no DB branch pointer", {
              branch: deterministicBranch,
              taskId: taskMeta.id,
            });
          } else {
            // An inspector with no branch to review and no recoverable remote
            // branch has nothing to inspect.
            sendOutput(
              `No branch found for task ${taskMeta.id} (checked DB and remote ${deterministicBranch}) — ` +
              "nothing to review yet.",
              "stderr"
            );
            logError("Inspector agent has no branch to review", { taskId: taskMeta.id, deterministicBranch });
            currentBranchName = null;
          }
        }
      }
    } catch (err) {
      sendOutput(`Warning: could not create task branch: ${err?.message || err}`, "stderr");
      logError("Failed to create task branch", { error: err?.message || String(err) });
      // Fall back to the TASK's own deterministic branch name — never a
      // session-scoped name. This worker container is reused across many
      // unrelated tasks over a loop session's lifetime (SESSION_ID stays
      // constant), so a fallback keyed only on SESSION_ID collides across
      // every task that ever hits this catch block during that session's
      // lifetime — or even across different sessions, since a colliding
      // name persisted as a task's `branch` in the DB gets reused verbatim
      // the next time ANY session reclaims that task. Two unrelated tasks
      // then land divergent commit histories on the exact same remote
      // branch, which manifests as a non-fast-forward push rejection and
      // (once the auto-rebase-retry hits a real conflict) an unresolvable
      // rebase failure — looking exactly like a git credential/permission
      // problem when the real cause is this naming collision. Basing it on
      // DEV_BRANCH (not an ambiguous current HEAD) keeps it consistent with
      // createTaskBranch()'s normal behavior.
      currentBranchName = buildBranchName(taskMeta.type || "task", taskMeta.id, taskMeta.title);
      try {
        execFileArgs("git", ["checkout", "-B", currentBranchName, DEV_BRANCH], { cwd: WORKSPACE });
        sendOutput(`Using fallback branch: ${currentBranchName} (from ${DEV_BRANCH})`, "stderr");
      } catch (fallbackErr) {
        logError("Fallback branch checkout failed", { error: fallbackErr?.message || String(fallbackErr) });
        // Absolute last resort: still task+session scoped so it can never
        // collide with another task's branch, even though it forfeits the
        // deterministic name other pipeline stages would look for.
        currentBranchName = `kirofactory/${SESSION_ID}-task${taskMeta.id}`;
        try {
          execFileArgs("git", ["checkout", "-B", currentBranchName], { cwd: WORKSPACE });
          sendOutput(`Using last-resort fallback branch: ${currentBranchName}`, "stderr");
        } catch (lastResortErr) {
          logError("Last-resort fallback branch checkout also failed", {
            error: lastResortErr?.message || String(lastResortErr),
          });
        }
      }
    }
  }

  if (!kiroReady || !kiroProc) {
    logInfo("kiro-cli not ready yet — queueing prompt", { queueLength: promptQueue.length + 1 });
    promptQueue.push(text);
    return;
  }

  // Every claimed task (taskMeta present) gets its own fresh ACP session —
  // zero conversation history carried over from whatever the previous task's
  // turn accumulated. This applies uniformly to first-time tasks, rework
  // passes on an existing branch/PR, and inspector review passes: in every
  // case the agent should read the current code/PR state fresh rather than
  // rely on memory of a previous turn. Interactive follow-ups (no taskMeta,
  // the user typing into an already-running session) intentionally skip this
  // and keep accumulating context, since that's the whole point of that mode.
  if (taskMeta) {
    createNewAcpSession().then(
      () => deliverPrompt(text),
      (err) => {
        const message = err?.message || String(err);
        logError("Failed to start fresh session for task — delivering on existing session instead", {
          taskId: taskMeta.id,
          error: message,
        });
        sendOutput(
          `Warning: could not start a fresh session for this task (${message}) — continuing on the existing session.`,
          "stderr"
        );
        deliverPrompt(text);
      }
    );
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
  turnVerdict = null;
  verdictToolCallId = null;
  try {
    writeFileSync(REVIEW_MARKER_PATH, "0");
  } catch (err) {
    logError("Failed to reset review-comment marker file", { error: err?.message || String(err) });
  }

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

/**
 * KiroFactory Worker Agent
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

import { spawn, execSync } from "node:child_process";
import { WebSocket } from "ws";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Configuration (from environment variables injected by orchestrator)
// ---------------------------------------------------------------------------

const SESSION_ID = process.env.SESSION_ID;
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;
const TASK_ID = process.env.TASK_ID;
const AGENT_NAME = process.env.AGENT_NAME || "developer-agent";
const REPO_URL = process.env.REPO_URL;
const DEV_BRANCH = process.env.DEV_BRANCH || "develop";
const KIRO_API_KEY = process.env.KIRO_API_KEY;
const GIT_USER_NAME = process.env.GIT_USER_NAME || "KiroFactory Agent";
const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL || "agent@kirofactory.dev";
const AZURE_DEVOPS_PAT = process.env.AZURE_DEVOPS_PAT;
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
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", component: "worker", sessionId: SESSION_ID, msg, ...extra }));
}
function logError(msg, extra) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", component: "worker", sessionId: SESSION_ID, msg, ...extra }));
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
      sessionId: SESSION_ID,
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
  ws.send(JSON.stringify({ action, sessionId: SESSION_ID, ...payload }));
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

function exec(cmd, opts = {}) {
  logInfo("exec", { cmd });
  return execSync(cmd, { encoding: "utf-8", timeout: 120_000, ...opts }).trim();
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
 * Create a task-specific branch from the current develop state.
 */
function createTaskBranch(taskMeta) {
  const branchName = buildBranchName(taskMeta.type || "task", taskMeta.id, taskMeta.title);
  exec(`git checkout -b "${branchName}"`, { cwd: WORKSPACE });
  sendOutput(`Created branch: ${branchName}`, "system");
  return branchName;
}

function setupRepo() {
  if (!REPO_URL) {
    logInfo("No REPO_URL — working in empty workspace");
    mkdirSync(WORKSPACE, { recursive: true });
    return;
  }

  let cloneUrl = REPO_URL;
  if (AZURE_DEVOPS_PAT && cloneUrl.includes("dev.azure.com")) {
    cloneUrl = cloneUrl.replace("https://", `https://pat:${AZURE_DEVOPS_PAT}@`);
  }
  // GitHub PAT authentication
  const githubPat = process.env.GITHUB_PAT;
  if (githubPat && cloneUrl.includes("github.com")) {
    cloneUrl = cloneUrl.replace("https://", `https://${githubPat}@`);
  }

  sendOutput("Cloning repository...", "system");
  exec(`git clone --branch ${DEV_BRANCH} "${cloneUrl}" ${WORKSPACE}`);

  exec(`git config user.name "${GIT_USER_NAME}"`, { cwd: WORKSPACE });
  exec(`git config user.email "${GIT_USER_EMAIL}"`, { cwd: WORKSPACE });

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
}

function commitAndPush() {
  let status = "";
  try {
    status = exec("git status --porcelain", { cwd: WORKSPACE });
  } catch {
    return { pushed: false, hasChanges: false }; // not a git workspace
  }
  if (!status) {
    sendOutput("No changes to commit", "system");
    return { pushed: false, hasChanges: false };
  }

  exec("git add -A", { cwd: WORKSPACE });

  // Build commit message with task info
  const taskId = currentTaskMeta?.id || TASK_ID || "unknown";
  const taskTitle = currentTaskMeta?.title || `task ${taskId}`;
  const commitTitle = `${taskTitle} [KiroFactory #${taskId}]`;
  const commitBody = currentTaskMeta
    ? `\nType: ${currentTaskMeta.type || "unknown"}\nID: ${taskId}\n\n${currentTaskMeta.description || ""}`
    : "";
  exec(`git commit -m "${commitTitle}${commitBody.replace(/"/g, '\\"')}"`, { cwd: WORKSPACE });

  const branchName = currentBranchName || `kirofactory/${SESSION_ID}`;
  exec(`git push origin "${branchName}"`, { cwd: WORKSPACE });
  sendOutput(`Pushed branch ${branchName}`, "system");
  return { pushed: true, hasChanges: true, branchName };
}

// ---------------------------------------------------------------------------
// GitHub PR creation
// ---------------------------------------------------------------------------

const GITHUB_PAT = process.env.GITHUB_PAT;

/**
 * Create a Pull Request via GitHub REST API.
 * Returns the PR URL on success, or null on failure.
 */
async function createPullRequest(branchName) {
  if (!GITHUB_PAT || !REPO_URL || !REPO_URL.includes("github.com")) {
    logInfo("Skipping PR creation — no GITHUB_PAT or non-GitHub repo");
    return null;
  }

  // Parse owner/repo from URL
  const match = REPO_URL.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) {
    logError("Cannot parse owner/repo from REPO_URL", { url: REPO_URL });
    return null;
  }
  const [, owner, repo] = match;

  const taskId = currentTaskMeta?.id || TASK_ID || "unknown";
  const taskTitle = currentTaskMeta?.title || `Task ${taskId}`;
  const taskDescription = currentTaskMeta?.description || "";
  const taskType = currentTaskMeta?.type || "task";

  const prTitle = `${taskTitle} [KiroFactory #${taskId}]`;
  const prBody = [
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
  ].join("\n");

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
        title: prTitle,
        body: prBody,
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
    logError("PR creation failed", { status: response.status, error: errorMsg });
    return null;
  } catch (err) {
    logError("PR creation network error", { error: err?.message || String(err) });
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
  sendReady("default");

  // Set up the git workspace (may throw → caller reports and shuts down).
  setupRepo();

  // Spawn the persistent kiro-cli acp process.
  spawnKiro();

  // If a prompt was pre-provided via env (legacy path), enqueue it.
  if (PROMPT_TEXT) {
    handlePrompt(PROMPT_TEXT);
  }
}

/** ID used for the ACP initialize handshake request. */
const INIT_REQUEST_ID = "__kiro_init__";
/** Maximum time (ms) to wait for kiro-cli ACP readiness before giving up. */
const KIRO_READY_TIMEOUT_MS = 60_000;

function spawnKiro() {
  const args = ["acp", "--agent", AGENT_NAME];
  const env = { ...process.env, KIRO_API_KEY, NO_COLOR: "1", FORCE_COLOR: "0" };

  sendOutput(`Starting kiro-cli acp --agent ${AGENT_NAME}`, "system");

  kiroProc = spawn("kiro-cli", args, { stdio: ["pipe", "pipe", "pipe"], env, cwd: WORKSPACE });

  let buffer = "";

  /** Timeout handle for kiro-cli readiness — if ACP handshake doesn't complete, fail fast. */
  const readyTimeout = setTimeout(() => {
    if (!kiroReady) {
      logError("kiro-cli did not complete ACP handshake within timeout", { timeoutMs: KIRO_READY_TIMEOUT_MS });
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
      try {
        const msg = JSON.parse(trimmed);
        // Forward ACP session updates.
        if (msg.method === "_kiro.dev/session/update" && msg.params?.update) {
          sendSessionUpdate(msg.params.update);
          continue;
        }

        // ACP initialize response — kiro-cli is ready to accept prompts.
        // kiro-cli manages its own session internally in ACP mode; we only need
        // the protocol handshake to confirm it's alive before sending prompts.
        if (msg.id === INIT_REQUEST_ID && (msg.result !== undefined || msg.error !== undefined)) {
          if (msg.error) {
            logError("ACP initialize failed", { error: msg.error });
            sendOutput(`kiro-cli ACP initialize failed: ${JSON.stringify(msg.error)}`, "stderr");
            clearTimeout(readyTimeout);
            try { kiroProc?.kill("SIGTERM"); } catch { /* noop */ }
            continue;
          }
          clearTimeout(readyTimeout);
          logInfo("ACP initialize complete — kiro-cli is ready");
          kiroReady = true;
          sendOutput(`kiro-cli ACP session ready`, "system");
          drainPromptQueue();
          continue;
        }

        // A JSON-RPC response whose id matches the in-flight prompt means the
        // prompt turn has completed — let the orchestrator send the next one.
        if (currentPromptId !== null && msg.id === currentPromptId && (msg.result !== undefined || msg.error !== undefined)) {
          const result = msg.error !== undefined ? { error: msg.error } : msg.result;
          currentPromptId = null;

          // After prompt completes: check for changes, commit, push, create PR
          (async () => {
            let hasChanges = false;
            let prUrl = null;
            try {
              const gitResult = commitAndPush();
              hasChanges = gitResult.hasChanges;
              if (gitResult.pushed && gitResult.branchName) {
                prUrl = await createPullRequest(gitResult.branchName);
              }
            } catch (err) {
              logError("Post-prompt git/PR operations failed", { error: err?.message || String(err) });
              sendOutput(`Post-prompt error: ${err?.message || err}`, "stderr");
            }
            sendPromptDone({ ...result, hasChanges, prUrl });
          })();
          continue;
        }

        // ACP requestPermission — auto-approve all tool use requests.
        // kiro-cli sends this as a JSON-RPC request when the agent wants to use
        // a tool that isn't in `allowedTools`. We must respond or the agent blocks.
        if (msg.method === "requestPermission" && msg.id !== undefined) {
          const options = msg.params?.options || [];
          // Pick "allow_once" first, then "allow_always", then first available
          const approve =
            options.find((o) => o.kind === "allow_once") ??
            options.find((o) => o.kind === "allow_always") ??
            options[0];

          const response = JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { outcome: { outcome: "selected", optionId: approve?.optionId || "allow" } },
          });
          kiroProc.stdin.write(response + "\n");
          continue;
        }

        // ACP sessionUpdate notification (alternative path — some versions send it as a request)
        if (msg.method === "sessionUpdate" && msg.params?.update) {
          sendSessionUpdate(msg.params.update);
          // If it has an id, it's a request needing an empty response
          if (msg.id !== undefined) {
            kiroProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
          }
          continue;
        }

        // Any other structured line — pass through as stdout text.
        sendOutput(trimmed, "stdout");
      } catch {
        sendOutput(trimmed, "stdout");
      }
    }
  });

  kiroProc.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) sendOutput(text, "stderr");
  });

  kiroProc.on("exit", (code) => {
    clearTimeout(readyTimeout);
    logInfo("kiro-cli exited", { code });
    kiroProc = null;
    kiroReady = false;
    // If kiro dies while the session is live, that's the end of the worker.
    commitOnExitAndShutdown(code ?? 0);
  });

  kiroProc.on("error", (err) => {
    clearTimeout(readyTimeout);
    logError("Failed to spawn kiro-cli", { error: err?.message || String(err) });
    kiroProc = null;
    kiroReady = false;
    sendOutput(`Failed to start kiro-cli: ${err?.message || String(err)}`, "stderr");
    gracefulShutdown(1);
  });

  // Send the ACP initialize handshake. kiro-cli responds once it's ready to
  // accept prompts. We mark kiroReady=true on the response and drain any
  // queued prompts. No newSession call is needed — kiro-cli manages sessions
  // internally in ACP mode (the session is "default").
  const initMsg = JSON.stringify({
    jsonrpc: "2.0",
    method: "initialize",
    id: INIT_REQUEST_ID,
    params: { protocolVersion: "2025-03-26", clientCapabilities: {} },
  });
  kiroProc.stdin.write(initMsg + "\n");
}

function handlePrompt(text, taskMeta) {
  if (!text) return;

  // If task metadata is provided and we have a git repo, create a task-specific branch
  if (taskMeta && REPO_URL) {
    currentTaskMeta = taskMeta;
    try {
      // Ensure we're on develop before branching (reset from any previous task)
      try { exec(`git checkout ${DEV_BRANCH}`, { cwd: WORKSPACE }); } catch { /* may already be on develop */ }
      currentBranchName = createTaskBranch(taskMeta);
    } catch (err) {
      sendOutput(`Warning: could not create task branch: ${err?.message || err}`, "stderr");
      logError("Failed to create task branch", { error: err?.message || String(err) });
      // Fall back to session-based branch
      currentBranchName = `kirofactory/${SESSION_ID}`;
      try { exec(`git checkout -b "${currentBranchName}"`, { cwd: WORKSPACE }); } catch { /* may already exist */ }
    }
  }

  if (!kiroReady || !kiroProc) {
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
  if (!kiroProc?.stdin?.writable) {
    promptQueue.push(text);
    return;
  }
  promptCounter += 1;
  currentPromptId = promptCounter;
  const promptMsg = JSON.stringify({
    jsonrpc: "2.0",
    method: "prompt",
    id: currentPromptId,
    params: { sessionId: "default", prompt: [{ type: "text", text }] },
  });
  kiroProc.stdin.write(promptMsg + "\n");
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

function commitOnExitAndShutdown(exitCode) {
  if (shuttingDown) return;
  try {
    const result = commitAndPush();
    if (result.pushed) sendOutput(`Changes pushed to ${result.branchName}`, "system");
  } catch (err) {
    logError("commit/push on exit failed", { error: err?.message || String(err) });
    sendOutput(`commit/push failed: ${err?.message || String(err)}`, "stderr");
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

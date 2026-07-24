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
import { mkdirSync } from "node:fs";

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
      handlePrompt(String(msg.text ?? ""));
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

  sendOutput("Cloning repository...", "system");
  exec(`git clone --depth 1 --branch ${DEV_BRANCH} "${cloneUrl}" ${WORKSPACE}`);

  exec(`git config user.name "${GIT_USER_NAME}"`, { cwd: WORKSPACE });
  exec(`git config user.email "${GIT_USER_EMAIL}"`, { cwd: WORKSPACE });

  const branchName = `kirofactory/${SESSION_ID}`;
  exec(`git checkout -b ${branchName}`, { cwd: WORKSPACE });
  sendOutput(`Workspace ready on branch ${branchName}`, "system");
}

function commitAndPush() {
  let status = "";
  try {
    status = exec("git status --porcelain", { cwd: WORKSPACE });
  } catch {
    return null; // not a git workspace (no REPO_URL)
  }
  if (!status) {
    sendOutput("No changes to commit", "system");
    return null;
  }

  exec("git add -A", { cwd: WORKSPACE });
  exec(`git commit -m "kirofactory: task ${TASK_ID || "unknown"}"`, { cwd: WORKSPACE });

  const branchName = `kirofactory/${SESSION_ID}`;
  exec(`git push origin ${branchName}`, { cwd: WORKSPACE });
  sendOutput(`Pushed branch ${branchName}`, "system");
  return branchName;
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

function spawnKiro() {
  const args = ["acp", "--agent", AGENT_NAME];
  const env = { ...process.env, KIRO_API_KEY, NO_COLOR: "1", FORCE_COLOR: "0" };

  sendOutput(`Starting kiro-cli acp --agent ${AGENT_NAME}`, "system");

  kiroProc = spawn("kiro-cli", args, { stdio: ["pipe", "pipe", "pipe"], env, cwd: WORKSPACE });

  let buffer = "";
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
        // A JSON-RPC response whose id matches the in-flight prompt means the
        // prompt turn has completed — let the orchestrator send the next one.
        if (currentPromptId !== null && msg.id === currentPromptId && (msg.result !== undefined || msg.error !== undefined)) {
          const result = msg.error !== undefined ? { error: msg.error } : msg.result;
          currentPromptId = null;
          sendPromptDone(result);
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
    logInfo("kiro-cli exited", { code });
    kiroProc = null;
    kiroReady = false;
    // If kiro dies while the session is live, that's the end of the worker.
    commitOnExitAndShutdown(code ?? 0);
  });

  kiroProc.on("error", (err) => {
    logError("Failed to spawn kiro-cli", { error: err?.message || String(err) });
    kiroProc = null;
    kiroReady = false;
    sendOutput(`Failed to start kiro-cli: ${err?.message || String(err)}`, "stderr");
    gracefulShutdown(1);
  });

  // Give kiro a moment to initialize its ACP session before we feed prompts.
  setTimeout(() => {
    kiroReady = true;
    drainPromptQueue();
  }, 3_000);
}

function handlePrompt(text) {
  if (!text) return;
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
    const branch = commitAndPush();
    if (branch) sendOutput(`Changes pushed to ${branch}`, "system");
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

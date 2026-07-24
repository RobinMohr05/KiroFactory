/**
 * KiroFactory Worker Agent
 *
 * Runs inside an Azure Container Apps Job. Responsibilities:
 * 1. Connect to the orchestrator via WebSocket
 * 2. Clone the repo and set up the workspace
 * 3. Spawn kiro-cli acp as a child process
 * 4. Stream output back to orchestrator
 * 5. On completion: commit, push, create PR
 * 6. Exit (container dies)
 */

import { spawn, execSync } from "node:child_process";
import { WebSocket } from "ws";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (!SESSION_ID || !ORCHESTRATOR_URL || !WORKER_SECRET) {
  console.error("FATAL: Missing required env vars (SESSION_ID, ORCHESTRATOR_URL, WORKER_SECRET)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// WebSocket connection to orchestrator
// ---------------------------------------------------------------------------

let ws;
let connected = false;

function connectToOrchestrator() {
  console.log(`[worker] Connecting to orchestrator: ${ORCHESTRATOR_URL}`);

  ws = new WebSocket(ORCHESTRATOR_URL);

  ws.on("open", () => {
    connected = true;
    console.log("[worker] Connected to orchestrator");

    // Authenticate
    ws.send(JSON.stringify({
      action: "worker-auth",
      sessionId: SESSION_ID,
      secret: WORKER_SECRET,
    }));

    // Start the work
    run().catch((err) => {
      sendEvent("error", { message: err.message || String(err) });
      process.exit(1);
    });
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleOrchestratorMessage(msg);
    } catch { /* ignore non-JSON */ }
  });

  ws.on("close", () => {
    connected = false;
    console.log("[worker] Disconnected from orchestrator");
  });

  ws.on("error", (err) => {
    console.error("[worker] WebSocket error:", err.message);
  });
}

function sendEvent(type, payload = {}) {
  if (!connected || !ws) return;
  ws.send(JSON.stringify({ type: `worker-${type}`, sessionId: SESSION_ID, ...payload }));
}

function handleOrchestratorMessage(msg) {
  if (msg.type === "stop") {
    console.log("[worker] Received stop signal from orchestrator");
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Git operations
// ---------------------------------------------------------------------------

function exec(cmd, opts = {}) {
  console.log(`[worker] $ ${cmd}`);
  return execSync(cmd, { encoding: "utf-8", timeout: 120_000, ...opts }).trim();
}

function setupRepo() {
  if (!REPO_URL) {
    console.log("[worker] No REPO_URL — skipping clone, working in empty workspace");
    mkdirSync(WORKSPACE, { recursive: true });
    return;
  }

  // Inject PAT into URL for Azure DevOps
  let cloneUrl = REPO_URL;
  if (AZURE_DEVOPS_PAT && cloneUrl.includes("dev.azure.com")) {
    cloneUrl = cloneUrl.replace("https://", `https://pat:${AZURE_DEVOPS_PAT}@`);
  }

  console.log(`[worker] Cloning repo...`);
  sendEvent("output", { text: `Cloning repository...`, stream: "system" });

  exec(`git clone --depth 1 --branch ${DEV_BRANCH} "${cloneUrl}" ${WORKSPACE}`);

  // Configure git identity
  exec(`git config user.name "${GIT_USER_NAME}"`, { cwd: WORKSPACE });
  exec(`git config user.email "${GIT_USER_EMAIL}"`, { cwd: WORKSPACE });

  // Create working branch
  const branchName = `kirofactory/${SESSION_ID}`;
  exec(`git checkout -b ${branchName}`, { cwd: WORKSPACE });

  sendEvent("output", { text: `Workspace ready on branch ${branchName}`, stream: "system" });
}

function commitAndPush() {
  // Check if there are changes
  const status = exec("git status --porcelain", { cwd: WORKSPACE });
  if (!status) {
    sendEvent("output", { text: "No changes to commit", stream: "system" });
    return null;
  }

  exec("git add -A", { cwd: WORKSPACE });
  exec(`git commit -m "kirofactory: task ${TASK_ID || 'unknown'}"`, { cwd: WORKSPACE });

  const branchName = `kirofactory/${SESSION_ID}`;
  exec(`git push origin ${branchName}`, { cwd: WORKSPACE });

  sendEvent("output", { text: `Pushed branch ${branchName}`, stream: "system" });
  return branchName;
}

// ---------------------------------------------------------------------------
// Kiro CLI execution
// ---------------------------------------------------------------------------

let kiroProc = null;

async function runKiro() {
  return new Promise((resolve, reject) => {
    const args = ["acp", "--agent", AGENT_NAME];
    const env = {
      ...process.env,
      KIRO_API_KEY,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    };

    sendEvent("output", { text: `Starting kiro-cli acp --agent ${AGENT_NAME}`, stream: "system" });

    kiroProc = spawn("kiro-cli", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: WORKSPACE,
    });

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
          // Forward session updates to orchestrator
          if (msg.method === "_kiro.dev/session/update" && msg.params?.update) {
            sendEvent("session-update", { update: msg.params.update });
          }
        } catch {
          // Non-JSON line — forward as output
          sendEvent("output", { text: trimmed, stream: "stdout" });
        }
      }
    });

    kiroProc.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) sendEvent("output", { text, stream: "stderr" });
    });

    kiroProc.on("exit", (code) => {
      kiroProc = null;
      if (code === 0) resolve();
      else reject(new Error(`kiro-cli exited with code ${code}`));
    });

    kiroProc.on("error", (err) => {
      kiroProc = null;
      reject(err);
    });

    // If we have a prompt, send it after a brief delay for initialization
    if (PROMPT_TEXT) {
      setTimeout(() => {
        // Send prompt via ACP protocol over stdin
        const promptMsg = JSON.stringify({
          jsonrpc: "2.0",
          method: "prompt",
          id: 1,
          params: {
            sessionId: "default",
            prompt: [{ type: "text", text: PROMPT_TEXT }],
          },
        });
        kiroProc?.stdin?.write(promptMsg + "\n");
      }, 3000);
    }
  });
}

// ---------------------------------------------------------------------------
// Main execution flow
// ---------------------------------------------------------------------------

async function run() {
  try {
    sendEvent("started", { taskId: TASK_ID, agent: AGENT_NAME });

    // 1. Clone and set up workspace
    setupRepo();

    // 2. Run Kiro agent
    await runKiro();

    // 3. Commit and push changes
    const branch = commitAndPush();

    // 4. Report completion
    sendEvent("completed", { taskId: TASK_ID, branch });

    console.log("[worker] Done. Exiting.");
    process.exit(0);
  } catch (err) {
    console.error("[worker] Fatal error:", err);
    sendEvent("error", { message: err.message || String(err), taskId: TASK_ID });
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanup() {
  if (kiroProc && kiroProc.exitCode === null) {
    kiroProc.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 2000);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

connectToOrchestrator();

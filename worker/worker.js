/**
 * KiroFactory Worker — Kiro ACP Session Worker
 *
 * This script runs inside a slim container and:
 * 1. Connects to the orchestrator via internal WebSocket
 * 2. Authenticates with session ID + worker secret
 * 3. Spawns kiro-cli acp as a child process
 * 4. Streams NDJSON output back to orchestrator
 * 5. Receives prompt commands from orchestrator
 * 6. On stop signal: gracefully ends ACP session, exits
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Configuration (from environment variables)
// ---------------------------------------------------------------------------

const CONFIG = {
  orchestratorUrl: process.env.ORCHESTRATOR_WS_URL || "ws://orchestrator:3500",
  sessionId: process.env.SESSION_ID || "",
  workerSecret: process.env.WORKER_SECRET || "",
  agentName: process.env.AGENT_NAME || "developer",
  workingDir: process.env.WORKING_DIR || "/workspace",
  timeoutSeconds: parseInt(process.env.TIMEOUT_SECONDS || "900", 10),
  model: process.env.MODEL || null,
  mcpProxyHost: process.env.MCP_PROXY_HOST || "localhost",
  mcpProxyPort: parseInt(process.env.MCP_PROXY_PORT || "9090", 10),
  healthPort: parseInt(process.env.HEALTH_PORT || "8080", 10),
  // Git workspace configuration
  repositoryUrl: process.env.REPOSITORY_URL || "",
  devBranch: process.env.DEV_BRANCH || "develop",
  azureDevOpsPat: process.env.AZURE_DEVOPS_EXT_PAT || "",
  gitUserName: process.env.GIT_USER_NAME || "KiroFactory Agent",
  gitUserEmail: process.env.GIT_USER_EMAIL || "agent@kirofactory.dev",
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ws = null;
let kiroProc = null;
let acpConn = null;
let acpSessionId = null;
let isShuttingDown = false;
let isHealthy = false;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, msg, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    sessionId: CONFIG.sessionId,
    ...(data || {}),
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

// ---------------------------------------------------------------------------
// Git workspace setup — clone repo, create working branch
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/**
 * Run a git command in the workspace directory.
 * Returns { stdout, stderr } on success, throws on failure.
 */
async function git(args, options = {}) {
  const opts = { cwd: CONFIG.workingDir, ...options };
  log("debug", `git ${args.join(" ")}`, { cwd: opts.cwd });
  return execFileAsync("git", args, opts);
}

/**
 * Slugify a task title for use as a branch name.
 * e.g. "Fix API response caching" → "fix-api-response-caching"
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/**
 * Set up the git workspace:
 * 1. Clone the repository (using AZURE_DEVOPS_EXT_PAT for auth)
 * 2. Checkout the dev/develop branch as reference
 * 3. Create a new working branch: kirofactory/<task-title-slug>-<short-id>
 * 4. Set git user.name and user.email
 * 5. Set /workspace as the kiro-cli working directory
 *
 * Reports progress and errors back to the orchestrator.
 * Returns true on success, false on failure.
 */
async function setupGitWorkspace() {
  if (!CONFIG.repositoryUrl) {
    log("info", "No REPOSITORY_URL configured — skipping git workspace setup");
    return true;
  }

  log("info", "Setting up git workspace", {
    repositoryUrl: CONFIG.repositoryUrl.replace(/\/\/[^@]+@/, "//***@"), // mask PAT in logs
    devBranch: CONFIG.devBranch,
  });

  sendToOrchestrator({
    action: "output",
    sessionId: CONFIG.sessionId,
    entry: {
      timestamp: new Date().toISOString(),
      stream: "system",
      text: `Cloning repository...`,
    },
  });

  try {
    // Build the authenticated clone URL
    // For Azure DevOps: https://<PAT>@dev.azure.com/org/project/_git/repo
    let cloneUrl = CONFIG.repositoryUrl;
    if (CONFIG.azureDevOpsPat) {
      const url = new URL(CONFIG.repositoryUrl);
      url.username = CONFIG.azureDevOpsPat;
      url.password = ""; // PAT goes in username for Azure DevOps
      cloneUrl = url.toString();
    }

    // 1. Clone the repository into /workspace
    //    Clone into a temp name then move contents, since /workspace must be the root
    await execFileAsync("git", ["clone", "--single-branch", "--branch", CONFIG.devBranch, cloneUrl, CONFIG.workingDir], {
      cwd: "/",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    log("info", "Repository cloned successfully");
    sendToOrchestrator({
      action: "output",
      sessionId: CONFIG.sessionId,
      entry: {
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `Repository cloned (branch: ${CONFIG.devBranch})`,
      },
    });

    // 2. Configure git user identity
    await git(["config", "user.name", CONFIG.gitUserName]);
    await git(["config", "user.email", CONFIG.gitUserEmail]);

    // 3. Create the working branch: kirofactory/<session-id-short>
    //    The session ID is used as a short identifier; the orchestrator may send
    //    a more descriptive branch name via the prompt later.
    const shortId = CONFIG.sessionId.slice(0, 8);
    const branchName = `kirofactory/${shortId}`;

    await git(["checkout", "-b", branchName]);

    log("info", "Working branch created", { branch: branchName });
    sendToOrchestrator({
      action: "output",
      sessionId: CONFIG.sessionId,
      entry: {
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `Working branch created: ${branchName}`,
      },
    });

    return true;
  } catch (err) {
    const errorMsg = err.stderr || err.message || String(err);
    log("error", "Git workspace setup failed", { error: errorMsg });

    sendToOrchestrator({
      action: "output",
      sessionId: CONFIG.sessionId,
      entry: {
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `❌ Git workspace setup failed: ${errorMsg}`,
      },
    });

    // Report failure to orchestrator
    sendToOrchestrator({
      action: "git-setup-failed",
      sessionId: CONFIG.sessionId,
      error: errorMsg,
    });

    return false;
  }
}

// ---------------------------------------------------------------------------
// Health check server (simple HTTP on port 8080)
// ---------------------------------------------------------------------------

const healthServer = createServer((req, res) => {
  if (req.url === "/healthz" && req.method === "GET") {
    if (isHealthy) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", sessionId: CONFIG.sessionId }));
    } else {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "starting", sessionId: CONFIG.sessionId }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(CONFIG.healthPort, "0.0.0.0", () => {
  log("info", `Health server listening on :${CONFIG.healthPort}`);
});

// ---------------------------------------------------------------------------
// WebSocket connection to orchestrator
// ---------------------------------------------------------------------------

function connectToOrchestrator() {
  log("info", "Connecting to orchestrator", { url: CONFIG.orchestratorUrl });

  ws = new WebSocket(CONFIG.orchestratorUrl);

  ws.on("open", () => {
    log("info", "Connected to orchestrator, authenticating...");

    // Authenticate with session ID + worker secret
    sendToOrchestrator({
      action: "worker-auth",
      sessionId: CONFIG.sessionId,
      secret: CONFIG.workerSecret,
    });
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleOrchestratorMessage(msg);
    } catch (err) {
      log("error", "Failed to parse orchestrator message", { error: err.message });
    }
  });

  ws.on("close", (code, reason) => {
    log("warn", "Orchestrator connection closed", { code, reason: reason.toString() });
    isHealthy = false;

    if (!isShuttingDown) {
      // Reconnect after a brief delay
      setTimeout(connectToOrchestrator, 3000);
    }
  });

  ws.on("error", (err) => {
    log("error", "WebSocket error", { error: err.message });
  });
}

function sendToOrchestrator(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ---------------------------------------------------------------------------
// Handle messages from orchestrator
// ---------------------------------------------------------------------------

/** Task metadata sent alongside a prompt (for commit messages and PR creation) */
let currentTaskMeta = null;

async function handleOrchestratorMessage(msg) {
  switch (msg.action) {
    case "auth-ok":
      log("info", "Authentication successful");
      isHealthy = true;
      // Set up git workspace (clone + branch) if configured
      const gitOk = await setupGitWorkspace();
      if (!gitOk) {
        log("error", "Git workspace setup failed — shutting down");
        await shutdown(1);
        break;
      }
      // Orchestrator confirmed auth + workspace ready — now spawn kiro-cli
      await spawnKiroCli();
      break;

    case "auth-failed":
      log("error", "Authentication failed", { reason: msg.reason });
      await shutdown(1);
      break;

    case "prompt":
      // Orchestrator wants us to send a prompt to the ACP session
      // Store task metadata for git operations after prompt completes
      currentTaskMeta = msg.taskMeta || null;
      if (msg.text) {
        await sendPrompt(msg.text);
      }
      break;

    case "stop":
      // Graceful stop requested
      log("info", "Stop signal received from orchestrator");
      await shutdown(0);
      break;

    default:
      log("warn", "Unknown orchestrator message", { action: msg.action });
  }
}

// ---------------------------------------------------------------------------
// Kiro CLI — Spawn and manage the ACP subprocess
// ---------------------------------------------------------------------------

async function spawnKiroCli() {
  log("info", "Spawning kiro-cli acp", {
    agent: CONFIG.agentName,
    cwd: CONFIG.workingDir,
  });

  // Build environment for kiro-cli
  const env = { ...process.env };
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";

  // If MCP proxy sidecar is available, set up ta-mcp-connect bridge
  if (CONFIG.mcpProxyHost && CONFIG.mcpProxyPort) {
    env.MCP_PROXY_HOST = CONFIG.mcpProxyHost;
    env.MCP_PROXY_PORT = String(CONFIG.mcpProxyPort);
  }

  const args = ["acp", "--agent", CONFIG.agentName];
  if (CONFIG.model) {
    args.push("--model", CONFIG.model);
  }

  kiroProc = spawn("kiro-cli", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    cwd: CONFIG.workingDir,
  });

  if (!kiroProc.pid) {
    log("error", "Failed to spawn kiro-cli");
    await shutdown(1);
    return;
  }

  log("info", "kiro-cli spawned", { pid: kiroProc.pid });

  // Stream stdout (NDJSON) to orchestrator
  let stdoutBuffer = "";
  kiroProc.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        handleAcpMessage(parsed);
      } catch {
        // Non-JSON line — forward as raw output
        sendToOrchestrator({
          action: "output",
          sessionId: CONFIG.sessionId,
          entry: {
            timestamp: new Date().toISOString(),
            stream: "stdout",
            text: trimmed,
          },
        });
      }
    }
  });

  // Stream stderr to orchestrator
  kiroProc.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      sendToOrchestrator({
        action: "output",
        sessionId: CONFIG.sessionId,
        entry: {
          timestamp: new Date().toISOString(),
          stream: "stderr",
          text,
        },
      });
    }
  });

  kiroProc.on("exit", (code, signal) => {
    log("info", "kiro-cli exited", { code, signal });
    sendToOrchestrator({
      action: "worker-exited",
      sessionId: CONFIG.sessionId,
      exitCode: code,
      signal,
    });

    if (!isShuttingDown) {
      // Unexpected exit — shut down the worker
      shutdown(code || 1);
    }
  });

  kiroProc.on("error", (err) => {
    log("error", "kiro-cli spawn error", { error: err.message });
    sendToOrchestrator({
      action: "output",
      sessionId: CONFIG.sessionId,
      entry: {
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `kiro-cli error: ${err.message}`,
      },
    });
    shutdown(1);
  });

  // Initialize ACP handshake
  await initializeAcp();
}

// ---------------------------------------------------------------------------
// ACP Protocol — Handshake and session creation via NDJSON/stdio
// ---------------------------------------------------------------------------

let acpSdk = null;
let messageId = 1;
const pendingRequests = new Map();

async function initializeAcp() {
  acpSdk = await import("@agentclientprotocol/sdk");

  // Send ACP initialize request
  sendToKiro({
    jsonrpc: "2.0",
    id: messageId,
    method: "initialize",
    params: {
      protocolVersion: acpSdk.PROTOCOL_VERSION,
      clientCapabilities: {},
    },
  });

  // Wait for initialize response, then create session
  pendingRequests.set(messageId, async (result) => {
    log("info", "ACP initialized", { protocolVersion: result?.protocolVersion });

    // Create a new session
    const sessionMsgId = ++messageId;
    sendToKiro({
      jsonrpc: "2.0",
      id: sessionMsgId,
      method: "session/new",
      params: {
        cwd: CONFIG.workingDir,
        mcpServers: [],
      },
    });

    pendingRequests.set(sessionMsgId, (sessionResult) => {
      acpSessionId = sessionResult?.sessionId;
      log("info", "ACP session created", { acpSessionId });

      sendToOrchestrator({
        action: "worker-ready",
        sessionId: CONFIG.sessionId,
        acpSessionId,
      });
    });
  });

  messageId++;
}

function sendToKiro(msg) {
  if (kiroProc && kiroProc.stdin && !kiroProc.stdin.destroyed) {
    kiroProc.stdin.write(JSON.stringify(msg) + "\n");
  }
}

function handleAcpMessage(msg) {
  // Response to a request we sent
  if ("id" in msg && msg.id && pendingRequests.has(msg.id)) {
    const handler = pendingRequests.get(msg.id);
    pendingRequests.delete(msg.id);
    handler(msg.result);
    return;
  }

  // Notification — kiro-cli extensions
  if ("method" in msg && typeof msg.method === "string") {
    if (msg.method === "_kiro.dev/session/update") {
      // Stream session updates to orchestrator
      sendToOrchestrator({
        action: "session-update",
        sessionId: CONFIG.sessionId,
        update: msg.params?.update || msg.params,
      });
      return;
    }

    // Permission request — auto-approve
    if (msg.method === "client/requestPermission" && "id" in msg) {
      const options = msg.params?.options || [];
      const approve =
        options.find((o) => o.kind === "allow_once") ||
        options.find((o) => o.kind === "allow_always") ||
        options[0];

      sendToKiro({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          outcome: { outcome: "selected", optionId: approve?.optionId || "allow" },
        },
      });
      return;
    }
  }

  // Forward any other NDJSON output as raw
  sendToOrchestrator({
    action: "output",
    sessionId: CONFIG.sessionId,
    entry: {
      timestamp: new Date().toISOString(),
      stream: "stdout",
      text: JSON.stringify(msg),
    },
  });
}

// ---------------------------------------------------------------------------
// Send prompt to ACP session
// ---------------------------------------------------------------------------

let promptId = 100;

async function sendPrompt(text) {
  if (!acpSessionId) {
    log("warn", "Cannot send prompt — no ACP session");
    sendToOrchestrator({
      action: "output",
      sessionId: CONFIG.sessionId,
      entry: {
        timestamp: new Date().toISOString(),
        stream: "system",
        text: "Cannot send prompt: ACP session not ready",
      },
    });
    return;
  }

  log("info", "Sending prompt to ACP session", { textLength: text.length });

  const msgId = ++promptId;
  sendToKiro({
    jsonrpc: "2.0",
    id: msgId,
    method: "session/prompt",
    params: {
      sessionId: acpSessionId,
      prompt: [{ type: "text", text }],
    },
  });

  pendingRequests.set(msgId, async (result) => {
    log("info", "Prompt completed");

    // After prompt completes, attempt auto-commit + push + PR creation
    // if a git workspace is configured and task metadata is available
    let gitResult = null;
    if (CONFIG.repositoryUrl && currentTaskMeta) {
      gitResult = await commitPushAndCreatePR(currentTaskMeta);
    }

    sendToOrchestrator({
      action: "prompt-done",
      sessionId: CONFIG.sessionId,
      result,
    });

    // Report git result separately (so orchestrator can display PR URL)
    if (gitResult) {
      sendToOrchestrator({
        action: "git-result",
        sessionId: CONFIG.sessionId,
        ...gitResult,
      });
    }

    // Clear task metadata after use
    currentTaskMeta = null;
  });
}

// ---------------------------------------------------------------------------
// Auto-commit, push, and PR creation
// ---------------------------------------------------------------------------

/**
 * After a task prompt completes successfully:
 * 1. Check for uncommitted changes
 * 2. Stage all changes (git add -A)
 * 3. Commit with a descriptive message (task title + KiroFactory ref)
 * 4. Push branch to origin
 * 5. Create a Pull Request via Azure DevOps REST API
 *
 * Returns an object describing the result (for reporting to orchestrator).
 * Handles edge cases:
 * - No changes: skip commit/PR
 * - Push fails: retry once, then report error
 * - PR creation fails: report partial success (branch pushed)
 */
async function commitPushAndCreatePR(taskMeta) {
  const result = {
    committed: false,
    pushed: false,
    prCreated: false,
    prUrl: null,
    error: null,
  };

  try {
    // 1. Check for changes
    const { stdout: statusOutput } = await git(["status", "--porcelain"]);
    if (!statusOutput || statusOutput.trim().length === 0) {
      log("info", "No changes to commit — skipping git operations");
      sendToOrchestrator({
        action: "output",
        sessionId: CONFIG.sessionId,
        entry: {
          timestamp: new Date().toISOString(),
          stream: "system",
          text: "No changes detected — skipping commit/push/PR.",
        },
      });
      return result;
    }

    const changedFiles = statusOutput.trim().split("\n").map((l) => l.trim());
    log("info", "Changes detected", { fileCount: changedFiles.length });

    // 2. Stage all changes
    await git(["add", "-A"]);

    // 3. Commit with descriptive message
    const commitTitle = `${taskMeta.title} [KiroFactory #${taskMeta.id}]`;
    const commitBody = taskMeta.description
      ? `\n\nTask: ${taskMeta.title}\nID: ${taskMeta.id}\n\n${taskMeta.description}`
      : "";
    const commitMessage = commitTitle + commitBody;

    await git(["commit", "-m", commitMessage]);
    result.committed = true;

    sendToOrchestrator({
      action: "output",
      sessionId: CONFIG.sessionId,
      entry: {
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `Committed: "${commitTitle}" (${changedFiles.length} file(s))`,
      },
    });

    // 4. Push branch to origin (with retry)
    const { stdout: branchOutput } = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const branchName = branchOutput.trim();

    let pushAttempts = 0;
    const maxPushAttempts = 2;
    while (pushAttempts < maxPushAttempts) {
      try {
        pushAttempts++;
        await git(["push", "-u", "origin", branchName]);
        result.pushed = true;
        break;
      } catch (pushErr) {
        const pushErrMsg = pushErr.stderr || pushErr.message || String(pushErr);
        if (pushAttempts < maxPushAttempts) {
          log("warn", "Push failed, retrying...", { error: pushErrMsg, attempt: pushAttempts });
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          log("error", "Push failed after retries", { error: pushErrMsg });
          result.error = `Push failed: ${pushErrMsg}`;
          sendToOrchestrator({
            action: "output",
            sessionId: CONFIG.sessionId,
            entry: {
              timestamp: new Date().toISOString(),
              stream: "system",
              text: `❌ Push failed after ${maxPushAttempts} attempts: ${pushErrMsg}`,
            },
          });
          return result;
        }
      }
    }

    sendToOrchestrator({
      action: "output",
      sessionId: CONFIG.sessionId,
      entry: {
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `Pushed branch "${branchName}" to origin`,
      },
    });

    // 5. Create Pull Request via Azure DevOps REST API
    if (!CONFIG.azureDevOpsPat || !CONFIG.repositoryUrl) {
      log("info", "No Azure DevOps PAT or repository URL — skipping PR creation");
      sendToOrchestrator({
        action: "output",
        sessionId: CONFIG.sessionId,
        entry: {
          timestamp: new Date().toISOString(),
          stream: "system",
          text: "Branch pushed but PR creation skipped (no Azure DevOps PAT configured).",
        },
      });
      return result;
    }

    try {
      const prUrl = await createPullRequest(branchName, taskMeta, changedFiles);
      result.prCreated = true;
      result.prUrl = prUrl;

      sendToOrchestrator({
        action: "output",
        sessionId: CONFIG.sessionId,
        entry: {
          timestamp: new Date().toISOString(),
          stream: "system",
          text: `✅ Pull Request created: ${prUrl}`,
        },
      });
    } catch (prErr) {
      const prErrMsg = prErr.message || String(prErr);
      log("error", "PR creation failed", { error: prErrMsg });
      result.error = `PR creation failed (branch pushed): ${prErrMsg}`;
      sendToOrchestrator({
        action: "output",
        sessionId: CONFIG.sessionId,
        entry: {
          timestamp: new Date().toISOString(),
          stream: "system",
          text: `⚠️ Branch pushed but PR creation failed: ${prErrMsg}`,
        },
      });
    }
  } catch (err) {
    const errMsg = err.stderr || err.message || String(err);
    log("error", "commitPushAndCreatePR failed", { error: errMsg });
    result.error = errMsg;
    sendToOrchestrator({
      action: "output",
      sessionId: CONFIG.sessionId,
      entry: {
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `❌ Git operations failed: ${errMsg}`,
      },
    });
  }

  return result;
}

/**
 * Create a Pull Request via Azure DevOps REST API.
 *
 * Azure DevOps Git Pull Request API:
 * POST https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/pullrequests?api-version=7.1
 *
 * The repository URL format: https://dev.azure.com/{org}/{project}/_git/{repo}
 * We parse org, project, and repo from CONFIG.repositoryUrl.
 *
 * Returns the PR web URL on success.
 */
async function createPullRequest(branchName, taskMeta, changedFiles) {
  // Parse Azure DevOps URL components
  // Expected format: https://dev.azure.com/{org}/{project}/_git/{repo}
  // or: https://{org}@dev.azure.com/{org}/{project}/_git/{repo}
  const repoUrl = CONFIG.repositoryUrl;
  const match = repoUrl.match(
    /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)/
  );

  if (!match) {
    throw new Error(
      `Cannot parse Azure DevOps URL from REPOSITORY_URL: ${repoUrl.replace(/\/\/[^@]+@/, "//***@")}`
    );
  }

  const [, org, project, repo] = match;

  // Build PR description with file change summary
  const filesSummary = changedFiles.length <= 20
    ? changedFiles.map((f) => `- ${f}`).join("\n")
    : changedFiles.slice(0, 20).map((f) => `- ${f}`).join("\n") +
      `\n- ... and ${changedFiles.length - 20} more files`;

  const prDescription = [
    taskMeta.description || "",
    "",
    "---",
    `**KiroFactory Task #${taskMeta.id}**`,
    "",
    "### Files Changed",
    filesSummary,
  ].join("\n");

  // Azure DevOps REST API — Create Pull Request
  const apiUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/pullrequests?api-version=7.1`;

  // PAT authentication: Base64 encode ":{PAT}"
  const authToken = Buffer.from(`:${CONFIG.azureDevOpsPat}`).toString("base64");

  const prBody = {
    sourceRefName: `refs/heads/${branchName}`,
    targetRefName: `refs/heads/${CONFIG.devBranch}`,
    title: taskMeta.title,
    description: prDescription,
  };

  log("info", "Creating Pull Request", {
    org,
    project,
    repo,
    source: branchName,
    target: CONFIG.devBranch,
  });

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(prBody),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Azure DevOps API ${response.status}: ${errorBody}`);
  }

  const prResult = await response.json();

  // The PR URL is typically in the response as a web link
  // Format: https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{prId}
  const prId = prResult.pullRequestId;
  const prWebUrl =
    prResult.url?.replace("/_apis/git/repositories/", "/_git/").replace(`/pullRequests/${prId}`, `/pullrequest/${prId}`) ||
    `https://dev.azure.com/${org}/${project}/_git/${repo}/pullrequest/${prId}`;

  log("info", "Pull Request created", { prId, prWebUrl });
  return prWebUrl;
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log("info", "Worker shutting down", { exitCode });

  // 1. Cancel the ACP session if active
  if (acpSessionId && kiroProc && kiroProc.exitCode === null) {
    try {
      const cancelId = ++messageId;
      sendToKiro({
        jsonrpc: "2.0",
        id: cancelId,
        method: "session/cancel",
        params: { sessionId: acpSessionId },
      });

      // Give kiro-cli a moment to clean up
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch {
      // Ignore — process may already be dead
    }
  }

  // 2. Kill kiro-cli subprocess if still alive
  if (kiroProc && kiroProc.exitCode === null) {
    kiroProc.kill("SIGTERM");

    // Wait up to 5s for graceful exit
    const deadline = Date.now() + 5000;
    while (kiroProc.exitCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    // Force kill if still alive
    if (kiroProc.exitCode === null) {
      kiroProc.kill("SIGKILL");
    }
  }

  // 3. Notify orchestrator
  sendToOrchestrator({
    action: "worker-shutdown",
    sessionId: CONFIG.sessionId,
    exitCode,
  });

  // 4. Close WebSocket
  if (ws) {
    ws.close(1000, "Worker shutting down");
  }

  // 5. Close health server
  healthServer.close();

  // 6. Exit
  setTimeout(() => process.exit(exitCode), 500);
}

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

process.on("uncaughtException", (err) => {
  log("error", "Uncaught exception", { error: err.message, stack: err.stack });
  shutdown(1);
});

process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled rejection", { reason: String(reason) });
  shutdown(1);
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

if (!CONFIG.sessionId) {
  log("error", "SESSION_ID environment variable is required");
  process.exit(1);
}

if (!CONFIG.workerSecret) {
  log("error", "WORKER_SECRET environment variable is required");
  process.exit(1);
}

log("info", "KiroFactory Worker starting", {
  sessionId: CONFIG.sessionId,
  agent: CONFIG.agentName,
  orchestrator: CONFIG.orchestratorUrl,
  workingDir: CONFIG.workingDir,
  timeout: CONFIG.timeoutSeconds,
});

// Set up overall timeout if configured
if (CONFIG.timeoutSeconds > 0) {
  setTimeout(() => {
    log("warn", "Worker timeout reached", { seconds: CONFIG.timeoutSeconds });
    sendToOrchestrator({
      action: "output",
      sessionId: CONFIG.sessionId,
      entry: {
        timestamp: new Date().toISOString(),
        stream: "system",
        text: `Worker timeout reached (${CONFIG.timeoutSeconds}s)`,
      },
    });
    shutdown(0);
  }, CONFIG.timeoutSeconds * 1000);
}

connectToOrchestrator();

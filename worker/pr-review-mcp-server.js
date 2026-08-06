#!/usr/bin/env node
/**
 * PR Review MCP Server — Lightweight stdio MCP server exposing tools for
 * reading and posting inline review comments on pull requests.
 *
 * Supports GitHub and Azure DevOps. Provider and credentials are read from
 * environment variables so this server runs as its own process without
 * importing worker.js:
 *
 *   REPO_URL          — e.g. https://github.com/org/repo
 *   GIT_PROVIDER      — "github" | "azure-devops" (optional, auto-detected from URL)
 *   GITHUB_PAT        — Personal Access Token for GitHub
 *   AZURE_DEVOPS_PAT  — Personal Access Token for Azure DevOps
 *   TASK_PR_URL       — Full URL to the pull request (html_url)
 *   DEV_BRANCH        — Target/base branch name (for reference)
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (MCP stdio transport).
 */

import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";

const SERVER_NAME = "pr-review-mcp-server";
const SERVER_VERSION = "1.0.0";

/**
 * Path to the review-comment counter file shared with verdict-mcp-server.js
 * (set by worker.js's buildMcpServers(), reset to "0" at the start of every
 * turn in deliverPrompt()). The verdict server reads this to refuse a
 * "changes_requested" verdict when zero comments were posted this turn.
 */
const REVIEW_MARKER_PATH = process.env.REVIEW_MARKER_PATH || "";

/** Increment the shared comment counter. Best-effort — never throws. */
function incrementReviewCommentCount() {
  if (!REVIEW_MARKER_PATH) return;
  try {
    const raw = readFileSync(REVIEW_MARKER_PATH, "utf-8").trim();
    const current = Number(raw);
    const next = (Number.isFinite(current) ? current : 0) + 1;
    writeFileSync(REVIEW_MARKER_PATH, String(next));
  } catch (err) {
    // Non-fatal — worst case the verdict guard fails open and doesn't block.
    process.stderr.write(`[pr-review-mcp-server] Failed to update comment counter: ${err?.message || err}\n`);
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const REPO_URL = process.env.REPO_URL || "";
const GIT_PROVIDER = process.env.GIT_PROVIDER || "";
const GITHUB_PAT = process.env.GITHUB_PAT || "";
const AZURE_DEVOPS_PAT = process.env.AZURE_DEVOPS_PAT || "";

/**
 * TASK_PR_URL is read at tool-call time, not at module load.
 *
 * The pr-review MCP server is spawned by kiro-cli at session/new time, before
 * any prompt arrives. The worker only knows the PR URL once it receives the
 * task metadata in handlePrompt() — at which point it sets process.env.TASK_PR_URL.
 * Reading this as a module-level constant would capture an empty string every time.
 */
function getTaskPrUrl() {
  return process.env.TASK_PR_URL || "";
}

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

function detectProvider() {
  if (GIT_PROVIDER === "github" || GIT_PROVIDER === "azure-devops") return GIT_PROVIDER;
  if (REPO_URL.includes("github.com")) return "github";
  if (REPO_URL.includes("dev.azure.com") || REPO_URL.includes("visualstudio.com"))
    return "azure-devops";
  return "unknown";
}

// ---------------------------------------------------------------------------
// URL parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract owner and repo from a GitHub repo URL.
 * Handles https://github.com/owner/repo and git@github.com:owner/repo.git
 */
function parseGitHubRepo(url) {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * Extract org, project, repo from an Azure DevOps repo URL.
 */
function parseAzureDevOpsRepo(url) {
  const modern = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/);
  if (modern) return { org: modern[1], project: modern[2], repo: modern[3].replace(/\.git$/, "") };
  const legacy = url.match(/([^/.@]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/?#]+)/);
  if (legacy) return { org: legacy[1], project: legacy[2], repo: legacy[3].replace(/\.git$/, "") };
  return null;
}

/**
 * Parse the PR number/ID from TASK_PR_URL.
 * GitHub: ".../pull/123"
 * Azure DevOps: ".../pullrequest/123"
 */
function parsePrNumber(url) {
  // GitHub
  const ghMatch = url.match(/\/pull\/(\d+)/);
  if (ghMatch) return parseInt(ghMatch[1], 10);
  // Azure DevOps
  const adoMatch = url.match(/\/pullrequest\/(\d+)/);
  if (adoMatch) return parseInt(adoMatch[1], 10);
  return null;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function githubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubGetPrComments(owner, repo, prNumber) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`;
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub GET comments failed: ${response.status} ${body}`);
  }
  const comments = await response.json();
  // Return all review comments (line-anchored); filter out resolved/outdated if needed
  return comments.map((c) => ({
    id: c.id,
    path: c.path,
    line: c.line || c.original_line,
    side: c.side,
    body: c.body,
    user: c.user?.login,
    createdAt: c.created_at,
  }));
}

async function githubGetPrHeadSha(owner, repo, prNumber) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub GET PR failed: ${response.status} ${body}`);
  }
  const pr = await response.json();
  return pr.head.sha;
}

async function githubPostReviewComment(owner, repo, prNumber, { path, line, body, side }) {
  const commitId = await githubGetPrHeadSha(owner, repo, prNumber);
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`;
  const payload = {
    body,
    commit_id: commitId,
    path,
    line,
    side: side || "RIGHT",
  };

  const response = await fetch(url, {
    method: "POST",
    headers: githubHeaders(),
    body: JSON.stringify(payload),
  });

  if (response.status === 201) {
    const data = await response.json();
    return { success: true, id: data.id, url: data.html_url };
  }

  // Inline comment failed — fall back to a general issue comment
  const errorBody = await response.text().catch(() => "");
  const fallbackBody = `**Code Review Comment**\n\n📁 \`${path}\` (line ${line})\n\n${body}\n\n---\n_Could not post as inline comment: ${response.status}_`;
  const fallbackUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;
  const fallbackResp = await fetch(fallbackUrl, {
    method: "POST",
    headers: githubHeaders(),
    body: JSON.stringify({ body: fallbackBody }),
  });

  if (fallbackResp.status === 201) {
    const data = await fallbackResp.json();
    return {
      success: true,
      fallback: true,
      id: data.id,
      url: data.html_url,
      note: `Inline comment failed (${response.status}), posted as general PR comment instead.`,
    };
  }

  const fallbackErr = await fallbackResp.text().catch(() => "");
  throw new Error(
    `GitHub POST comment failed: inline=${response.status} (${errorBody}), fallback=${fallbackResp.status} (${fallbackErr})`
  );
}

// ---------------------------------------------------------------------------
// Azure DevOps API helpers
// ---------------------------------------------------------------------------

function adoHeaders() {
  return {
    Authorization: `Basic ${Buffer.from(`:${AZURE_DEVOPS_PAT}`).toString("base64")}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function adoBaseUrl(org, project, repo) {
  return (
    `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}` +
    `/_apis/git/repositories/${encodeURIComponent(repo)}`
  );
}

async function adoGetPrComments(org, project, repo, prId) {
  const url = `${adoBaseUrl(org, project, repo)}/pullrequests/${prId}/threads?api-version=7.1`;
  const response = await fetch(url, { headers: adoHeaders() });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Azure DevOps GET threads failed: ${response.status} ${body}`);
  }
  const data = await response.json();
  const threads = data.value || [];

  // Filter to active/pending threads, skip system-generated ones
  const results = [];
  for (const thread of threads) {
    const status = thread.status;
    if (status !== "active" && status !== "pending") continue;
    // System threads have no comments authored by users or have isDeleted
    const comments = (thread.comments || []).filter(
      (c) => c.commentType !== "system" && !c.isDeleted
    );
    if (comments.length === 0) continue;

    const ctx = thread.threadContext;
    results.push({
      id: thread.id,
      path: ctx?.filePath || null,
      line: ctx?.rightFileStart?.line || ctx?.leftFileStart?.line || null,
      body: comments[0].content,
      user: comments[0].author?.displayName,
      status,
    });
  }
  return results;
}

async function adoPostReviewComment(org, project, repo, prId, { path, line, body }) {
  const baseUrl = `${adoBaseUrl(org, project, repo)}/pullrequests/${prId}/threads?api-version=7.1`;

  // Attempt inline (line-anchored) comment
  const threadContext = {
    filePath: path,
    rightFileStart: { line, offset: 1 },
    rightFileEnd: { line, offset: 1 },
  };

  const payload = {
    comments: [{ parentCommentId: 0, content: body, commentType: "text" }],
    status: "active",
    threadContext,
  };

  const response = await fetch(baseUrl, {
    method: "POST",
    headers: adoHeaders(),
    body: JSON.stringify(payload),
  });

  if (response.status === 200 || response.status === 201) {
    const data = await response.json();
    return { success: true, id: data.id };
  }

  // Inline failed — fall back to a general (non-inline) thread
  const errorBody = await response.text().catch(() => "");
  const fallbackBody = `**Code Review Comment**\n\n📁 \`${path}\` (line ${line})\n\n${body}\n\n---\n_Could not post as inline comment: ${response.status}_`;
  const fallbackPayload = {
    comments: [{ parentCommentId: 0, content: fallbackBody, commentType: "text" }],
    status: "active",
  };

  const fallbackResp = await fetch(baseUrl, {
    method: "POST",
    headers: adoHeaders(),
    body: JSON.stringify(fallbackPayload),
  });

  if (fallbackResp.status === 200 || fallbackResp.status === 201) {
    const data = await fallbackResp.json();
    return {
      success: true,
      fallback: true,
      id: data.id,
      note: `Inline comment failed (${response.status}), posted as general PR comment instead.`,
    };
  }

  const fallbackErr = await fallbackResp.text().catch(() => "");
  throw new Error(
    `Azure DevOps POST thread failed: inline=${response.status} (${errorBody}), fallback=${fallbackResp.status} (${fallbackErr})`
  );
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "get_pr_review_comments",
    description:
      "Fetch existing review comments/threads on the task's pull request. " +
      "Returns unresolved/active inline comments as a list of { path, line, body, user }.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "post_review_comment",
    description:
      "Post ONE inline, line-anchored review comment on the task's pull request for a single issue. " +
      "If the path/line cannot be resolved to a valid diff position, falls back to a general " +
      "PR comment so the issue is never silently dropped.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the repo root (e.g. 'src/index.ts').",
        },
        line: {
          type: "integer",
          description: "Line number in the file (1-based) where the comment should be anchored.",
        },
        body: {
          type: "string",
          description: "The review comment text (supports Markdown).",
        },
        side: {
          type: "string",
          enum: ["LEFT", "RIGHT"],
          description:
            "Which side of the diff to comment on. Defaults to RIGHT (new file version). " +
            "Only relevant for GitHub.",
        },
      },
      required: ["path", "line", "body"],
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

function notify(method, params) {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
  process.stdout.write(msg + "\n");
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

async function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      notify("notifications/initialized", {});
      break;

    case "tools/list":
      respond(id, { tools: TOOLS });
      break;

    case "tools/call":
      await handleToolCall(id, params);
      break;

    case "ping":
      respond(id, {});
      break;

    default:
      if (id !== undefined) {
        respondError(id, -32601, `Method not found: ${method}`);
      }
      break;
  }
}

async function handleToolCall(id, params) {
  const toolName = params?.name;
  const args = params?.arguments ?? {};

  switch (toolName) {
    case "get_pr_review_comments":
      await handleGetComments(id);
      break;
    case "post_review_comment":
      await handlePostComment(id, args);
      break;
    default:
      respondError(id, -32602, `Unknown tool: ${toolName}`);
      break;
  }
}

async function handleGetComments(id) {
  const provider = detectProvider();
  const TASK_PR_URL = getTaskPrUrl();
  const prNumber = parsePrNumber(TASK_PR_URL);

  if (!prNumber) {
    respond(id, {
      content: [{ type: "text", text: `Error: Could not parse PR number from TASK_PR_URL: "${TASK_PR_URL}"` }],
      isError: true,
    });
    return;
  }

  try {
    let comments;
    if (provider === "github") {
      if (!GITHUB_PAT) {
        respond(id, {
          content: [{ type: "text", text: "Error: GITHUB_PAT environment variable is not set." }],
          isError: true,
        });
        return;
      }
      const parsed = parseGitHubRepo(REPO_URL);
      if (!parsed) {
        respond(id, {
          content: [{ type: "text", text: `Error: Cannot parse owner/repo from REPO_URL: "${REPO_URL}"` }],
          isError: true,
        });
        return;
      }
      comments = await githubGetPrComments(parsed.owner, parsed.repo, prNumber);
    } else if (provider === "azure-devops") {
      if (!AZURE_DEVOPS_PAT) {
        respond(id, {
          content: [{ type: "text", text: "Error: AZURE_DEVOPS_PAT environment variable is not set." }],
          isError: true,
        });
        return;
      }
      const parsed = parseAzureDevOpsRepo(REPO_URL);
      if (!parsed) {
        respond(id, {
          content: [{ type: "text", text: `Error: Cannot parse org/project/repo from REPO_URL: "${REPO_URL}"` }],
          isError: true,
        });
        return;
      }
      comments = await adoGetPrComments(parsed.org, parsed.project, parsed.repo, prNumber);
    } else {
      respond(id, {
        content: [{ type: "text", text: `Error: Unsupported git provider: "${provider}". Set GIT_PROVIDER or use a GitHub/Azure DevOps REPO_URL.` }],
        isError: true,
      });
      return;
    }

    respond(id, {
      content: [{ type: "text", text: JSON.stringify(comments, null, 2) }],
    });
  } catch (err) {
    respond(id, {
      content: [{ type: "text", text: `Error fetching PR comments: ${err.message || err}` }],
      isError: true,
    });
  }
}

async function handlePostComment(id, args) {
  const { path, line, body, side } = args;

  if (!path || typeof path !== "string") {
    respond(id, {
      content: [{ type: "text", text: 'Error: "path" is required and must be a non-empty string.' }],
      isError: true,
    });
    return;
  }
  if (!line || typeof line !== "number" || line < 1) {
    respond(id, {
      content: [{ type: "text", text: 'Error: "line" is required and must be a positive integer.' }],
      isError: true,
    });
    return;
  }
  if (!body || typeof body !== "string") {
    respond(id, {
      content: [{ type: "text", text: 'Error: "body" is required and must be a non-empty string.' }],
      isError: true,
    });
    return;
  }

  const provider = detectProvider();
  const TASK_PR_URL = getTaskPrUrl();
  const prNumber = parsePrNumber(TASK_PR_URL);

  if (!prNumber) {
    respond(id, {
      content: [{ type: "text", text: `Error: Could not parse PR number from TASK_PR_URL: "${TASK_PR_URL}"` }],
      isError: true,
    });
    return;
  }

  try {
    let result;
    if (provider === "github") {
      if (!GITHUB_PAT) {
        respond(id, {
          content: [{ type: "text", text: "Error: GITHUB_PAT environment variable is not set." }],
          isError: true,
        });
        return;
      }
      const parsed = parseGitHubRepo(REPO_URL);
      if (!parsed) {
        respond(id, {
          content: [{ type: "text", text: `Error: Cannot parse owner/repo from REPO_URL: "${REPO_URL}"` }],
          isError: true,
        });
        return;
      }
      result = await githubPostReviewComment(parsed.owner, parsed.repo, prNumber, {
        path,
        line,
        body,
        side,
      });
    } else if (provider === "azure-devops") {
      if (!AZURE_DEVOPS_PAT) {
        respond(id, {
          content: [{ type: "text", text: "Error: AZURE_DEVOPS_PAT environment variable is not set." }],
          isError: true,
        });
        return;
      }
      const parsed = parseAzureDevOpsRepo(REPO_URL);
      if (!parsed) {
        respond(id, {
          content: [{ type: "text", text: `Error: Cannot parse org/project/repo from REPO_URL: "${REPO_URL}"` }],
          isError: true,
        });
        return;
      }
      result = await adoPostReviewComment(parsed.org, parsed.project, parsed.repo, prNumber, {
        path,
        line,
        body,
      });
    } else {
      respond(id, {
        content: [{ type: "text", text: `Error: Unsupported git provider: "${provider}". Set GIT_PROVIDER or use a GitHub/Azure DevOps REPO_URL.` }],
        isError: true,
      });
      return;
    }

    // A comment was actually posted (inline or as a general-comment fallback) —
    // count it so verdict-mcp-server.js can allow a "changes_requested" verdict.
    incrementReviewCommentCount();

    respond(id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    });
  } catch (err) {
    respond(id, {
      content: [{ type: "text", text: `Error posting review comment: ${err.message || err}` }],
      isError: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, terminal: false });

// Track pending async operations
let pendingOps = 0;
let closing = false;

function maybExit() {
  if (closing && pendingOps === 0) {
    process.exit(0);
  }
}

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    if (msg.method && msg.id !== undefined) {
      pendingOps++;
      try {
        await handleRequest(msg);
      } finally {
        pendingOps--;
        maybExit();
      }
    }
    // Notifications (no id) — ignore silently
  } catch {
    // Non-JSON line — ignore
  }
});

rl.on("close", () => {
  closing = true;
  maybExit();
});

#!/usr/bin/env node
/**
 * PR Complete MCP Server — Lightweight stdio MCP server exposing
 * `complete_pull_request` for merging a PR and deleting its source branch.
 *
 * Used by the QA agent to auto-complete PRs when the tab has `autoMergePrs`
 * enabled. The tool does NOT accept a PR URL or branch name as input — it
 * reads them from environment variables set by the worker:
 *
 *   PR_URL              — Full pull request URL (e.g. https://github.com/owner/repo/pull/123)
 *   PR_BRANCH           — Source branch name to delete after merge
 *   REPO_URL            — Repository URL (to detect provider: github vs azure-devops)
 *   GITHUB_PAT          — GitHub Personal Access Token
 *   AZURE_DEVOPS_PAT    — Azure DevOps Personal Access Token
 *   ALL_GROUP_TASKS_DONE — "true" if all sibling tasks in the group are done
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (MCP stdio transport).
 */

import { createInterface } from "node:readline";

const SERVER_NAME = "pr-complete-mcp-server";
const SERVER_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const PR_URL = process.env.PR_URL || "";
const PR_BRANCH = process.env.PR_BRANCH || "";
const REPO_URL = process.env.REPO_URL || "";
const GITHUB_PAT = process.env.GITHUB_PAT || "";
const AZURE_DEVOPS_PAT = process.env.AZURE_DEVOPS_PAT || "";
const ALL_GROUP_TASKS_DONE = process.env.ALL_GROUP_TASKS_DONE || "true";

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const TOOL_DEFINITION = {
  name: "complete_pull_request",
  description:
    "Merge an open pull request and delete its source branch. Call this tool " +
    "after QA passes to complete the PR. The PR URL and branch are read from " +
    "the environment — you only need to provide a reason.",
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "Brief explanation of why the PR is being completed (e.g. 'QA passed, no defects found')",
      },
    },
    required: ["reason"],
  },
};

// ---------------------------------------------------------------------------
// URL Parsing
// ---------------------------------------------------------------------------

/**
 * Parse owner/repo/number from a GitHub PR URL.
 */
function parseGitHubPrUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

/**
 * Parse org/project/repo/id from an Azure DevOps PR URL.
 */
function parseAzureDevOpsPrUrl(url) {
  const match = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/);
  if (match) {
    return { org: match[1], project: match[2], repo: match[3], id: parseInt(match[4], 10) };
  }
  const legacy = url.match(/([^/.@]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/);
  if (legacy) {
    return { org: legacy[1], project: legacy[2], repo: legacy[3], id: parseInt(legacy[4], 10) };
  }
  return null;
}

/**
 * Detect provider from REPO_URL.
 */
function detectProvider() {
  if (REPO_URL.includes("github.com")) return "github";
  if (REPO_URL.includes("dev.azure.com") || REPO_URL.includes("visualstudio.com")) return "azure-devops";
  // Try PR_URL as well
  if (PR_URL.includes("github.com")) return "github";
  if (PR_URL.includes("dev.azure.com") || PR_URL.includes("visualstudio.com")) return "azure-devops";
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

/**
 * Attempt to merge a GitHub PR with the given method.
 * Returns { success, status, body }.
 */
async function githubMergePr(owner, repo, number, method) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/merge`;
  const response = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(),
    body: JSON.stringify({ merge_method: method }),
  });
  const body = await response.json().catch(() => ({}));
  return { success: response.status === 200, status: response.status, body };
}

/**
 * Delete a branch on GitHub.
 */
async function githubDeleteBranch(owner, repo, branch) {
  // Encode each path segment individually to preserve slashes (e.g. "feature/#544_...")
  const refPath = branch.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${refPath}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: githubHeaders(),
  });
  return { success: response.status === 204, status: response.status };
}

/**
 * Full GitHub merge flow: squash → merge → rebase fallback.
 * Retries up to 2 times on transient failures per method.
 */
async function completeGitHubPr(owner, repo, number, branch) {
  const methods = ["squash", "merge", "rebase"];

  for (const method of methods) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await githubMergePr(owner, repo, number, method);

      if (result.success) {
        // Merge succeeded — attempt to delete the branch
        if (branch) {
          try {
            const deleteResult = await githubDeleteBranch(owner, repo, branch);
            const branchMsg = deleteResult.success
              ? `Branch "${branch}" deleted.`
              : `Branch "${branch}" could not be deleted (HTTP ${deleteResult.status}).`;
            return {
              success: true,
              message: `PR #${number} merged successfully (method: ${method}). ${branchMsg}`,
            };
          } catch (err) {
            // Branch deletion failed (network error, etc.) but merge already succeeded
            return {
              success: true,
              message: `PR #${number} merged successfully (method: ${method}). Branch "${branch}" could not be deleted (${err?.message || "unknown error"}).`,
            };
          }
        }
        return {
          success: true,
          message: `PR #${number} merged successfully (method: ${method}).`,
        };
      }

      // 409 = merge conflict — not retryable, not method-dependent
      if (result.status === 409) {
        return {
          success: false,
          error: "merge_conflict",
          message: "PR has merge conflicts that must be resolved before merging.",
        };
      }

      // 405 = method not allowed — skip to next method immediately
      if (result.status === 405) {
        break;
      }

      // Other errors (403, 422, etc.) — retry this method
      if (attempt < 2) {
        await sleep(5000);
      }
    }
  }

  return {
    success: false,
    error: "merge_failed",
    message: `Failed to merge PR #${number} after all retries.`,
  };
}

// ---------------------------------------------------------------------------
// Azure DevOps API helpers
// ---------------------------------------------------------------------------

function azureDevOpsHeaders() {
  const token = Buffer.from(`:${AZURE_DEVOPS_PAT}`).toString("base64");
  return {
    Authorization: `Basic ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Complete an Azure DevOps PR (sets status to completed with branch deletion).
 * Falls back from squash to noFastForward if squash is disallowed.
 */
async function completeAzureDevOpsPr(org, project, repo, prId) {
  const strategies = ["squash", "noFastForward"];

  for (const strategy of strategies) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const url =
        `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}` +
        `/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}` +
        `?api-version=7.1`;

      // Azure DevOps requires the last merge source commit for completion
      let lastMergeSourceCommit;
      try {
        const getResponse = await fetch(url, { method: "GET", headers: azureDevOpsHeaders() });
        if (getResponse.ok) {
          const prData = await getResponse.json();
          lastMergeSourceCommit = prData.lastMergeSourceCommit;
        }
      } catch {
        // Non-fatal — proceed without it
      }

      const body = {
        status: "completed",
        lastMergeSourceCommit,
        completionOptions: {
          deleteSourceBranch: true,
          mergeStrategy: strategy,
        },
      };

      const response = await fetch(url, {
        method: "PATCH",
        headers: azureDevOpsHeaders(),
        body: JSON.stringify(body),
      });

      if (response.ok) {
        return {
          success: true,
          message: `PR #${prId} completed successfully (strategy: ${strategy}). Source branch deleted.`,
        };
      }

      const responseBody = await response.json().catch(() => ({}));

      // 409 = conflict (merge conflicts or already completed)
      if (response.status === 409) {
        const msg = responseBody?.message || "PR has conflicts or is already completed.";
        if (msg.toLowerCase().includes("conflict")) {
          return {
            success: false,
            error: "merge_conflict",
            message: "PR has merge conflicts that must be resolved before merging.",
          };
        }
        return {
          success: false,
          error: "merge_failed",
          message: `Azure DevOps 409: ${msg}`,
        };
      }

      // If the strategy was rejected (400), skip to next strategy
      if (response.status === 400) {
        break;
      }

      // Other errors — retry this strategy
      if (attempt < 2) {
        await sleep(5000);
      }
    }
  }

  return {
    success: false,
    error: "merge_failed",
    message: `Failed to complete PR #${prId} after all retries.`,
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      // Send initialized notification after responding
      notify("notifications/initialized", {});
      break;

    case "tools/list":
      respond(id, { tools: [TOOL_DEFINITION] });
      break;

    case "tools/call":
      try {
        await handleToolCall(id, params);
      } catch (err) {
        respondError(id, -32603, `Internal error: ${err?.message || err}`);
      }
      break;

    case "ping":
      respond(id, {});
      break;

    default:
      // Unknown method — respond with method-not-found
      if (id !== undefined) {
        respondError(id, -32601, `Method not found: ${method}`);
      }
      break;
  }
}

async function handleToolCall(id, params) {
  const toolName = params?.name;
  const args = params?.arguments ?? {};

  if (toolName !== "complete_pull_request") {
    respondError(id, -32602, `Unknown tool: ${toolName}`);
    return;
  }

  const { reason } = args;

  if (!reason || typeof reason !== "string") {
    respond(id, {
      content: [
        { type: "text", text: 'Error: "reason" is required and must be a non-empty string.' },
      ],
      isError: true,
    });
    return;
  }

  // Check group completion status before attempting merge
  if (ALL_GROUP_TASKS_DONE === "false") {
    respond(id, {
      content: [
        {
          type: "text",
          text:
            "PR merge deferred — sibling tasks in this group have not all completed QA yet. " +
            "The PR will be merged when the final task in the group passes QA.",
        },
      ],
    });
    return;
  }

  // Validate PR_URL is set
  if (!PR_URL) {
    respond(id, {
      content: [
        { type: "text", text: "Error: PR_URL environment variable is not set. Cannot merge without a PR URL." },
      ],
      isError: true,
    });
    return;
  }

  const provider = detectProvider();

  if (provider === "github") {
    const parsed = parseGitHubPrUrl(PR_URL);
    if (!parsed) {
      respond(id, {
        content: [
          { type: "text", text: `Error: Could not parse GitHub PR URL: ${PR_URL}` },
        ],
        isError: true,
      });
      return;
    }

    if (!GITHUB_PAT) {
      respond(id, {
        content: [
          { type: "text", text: "Error: GITHUB_PAT environment variable is not set. Cannot authenticate with GitHub." },
        ],
        isError: true,
      });
      return;
    }

    const result = await completeGitHubPr(parsed.owner, parsed.repo, parsed.number, PR_BRANCH);
    if (result.success) {
      respond(id, {
        content: [{ type: "text", text: result.message }],
      });
    } else {
      respond(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: result.error, message: result.message }),
          },
        ],
        isError: result.error !== "merge_conflict", // merge_conflict is not an MCP error — agent can act on it
      });
    }
  } else if (provider === "azure-devops") {
    const parsed = parseAzureDevOpsPrUrl(PR_URL);
    if (!parsed) {
      respond(id, {
        content: [
          { type: "text", text: `Error: Could not parse Azure DevOps PR URL: ${PR_URL}` },
        ],
        isError: true,
      });
      return;
    }

    if (!AZURE_DEVOPS_PAT) {
      respond(id, {
        content: [
          { type: "text", text: "Error: AZURE_DEVOPS_PAT environment variable is not set. Cannot authenticate with Azure DevOps." },
        ],
        isError: true,
      });
      return;
    }

    const result = await completeAzureDevOpsPr(parsed.org, parsed.project, parsed.repo, parsed.id);
    if (result.success) {
      respond(id, {
        content: [{ type: "text", text: result.message }],
      });
    } else {
      respond(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: result.error, message: result.message }),
          },
        ],
        isError: result.error !== "merge_conflict",
      });
    }
  } else {
    respond(id, {
      content: [
        { type: "text", text: `Error: Could not detect git provider from REPO_URL (${REPO_URL}) or PR_URL (${PR_URL}).` },
      ],
      isError: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    if (msg.method && msg.id !== undefined) {
      handleRequest(msg).catch((err) => {
        respondError(msg.id, -32603, `Internal error: ${err?.message || err}`);
      });
    }
    // Notifications (no id) — ignore silently
  } catch {
    // Non-JSON line — ignore
  }
});

rl.on("close", () => {
  process.exit(0);
});

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
/**
 * When "true", the branch is still referenced by another currently-active (non-done)
 * task. Branch deletion must be skipped — deleting it now would destroy a branch that
 * another task still needs. Set by worker.js from the taskMeta.branchHasActiveTasks
 * flag computed by the backend via getTasksByBranch().
 */
const BRANCH_HAS_ACTIVE_TASKS = process.env.BRANCH_HAS_ACTIVE_TASKS || "false";
// Override for testing: redirect GitHub API calls to a local mock server.
const GITHUB_BASE_URL = process.env.GITHUB_BASE_URL || "https://api.github.com";
// Override for testing: reduce the poll interval for 'unknown' mergeability checks (ms).
const GITHUB_UNKNOWN_POLL_INTERVAL_MS = parseInt(process.env.GITHUB_UNKNOWN_POLL_INTERVAL_MS || "2000", 10);
// Override for testing: reduce the branch delete retry delay (ms).
const GITHUB_DELETE_RETRY_DELAY_MS = parseInt(process.env.GITHUB_DELETE_RETRY_DELAY_MS || "3000", 10);
// Override for testing: redirect Azure DevOps API calls to a local mock server.
const AZURE_DEVOPS_BASE_URL = process.env.AZURE_DEVOPS_BASE_URL || "https://dev.azure.com";
// Override for testing: reduce the poll interval for queued merge status checks (ms).
const AZURE_DEVOPS_QUEUED_POLL_INTERVAL_MS = parseInt(process.env.AZURE_DEVOPS_QUEUED_POLL_INTERVAL_MS || "2000", 10);

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
    "User-Agent": "KiroFactory-Worker",
  };
}

/**
 * GET a GitHub PR and return its mergeability signals.
 * Returns { ok, status, mergeable, mergeableState }.
 */
async function githubGetPr(owner, repo, number) {
  const url = `${GITHUB_BASE_URL}/repos/${owner}/${repo}/pulls/${number}`;
  const response = await fetch(url, { method: "GET", headers: githubHeaders() });
  const body = await response.json().catch(() => ({}));
  return {
    ok: response.status === 200,
    status: response.status,
    mergeable: body?.mergeable,
    mergeableState: body?.mergeable_state,
  };
}

/**
 * Attempt to merge a GitHub PR with the given method.
 * Returns { success, status, body }.
 */
async function githubMergePr(owner, repo, number, method) {
  const url = `${GITHUB_BASE_URL}/repos/${owner}/${repo}/pulls/${number}/merge`;
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
 * Returns { success, status }.
 */
async function githubDeleteBranch(owner, repo, branch) {
  // Encode each path segment individually to preserve slashes (e.g. "feature/#544_...")
  const refPath = branch.split("/").map(encodeURIComponent).join("/");
  const url = `${GITHUB_BASE_URL}/repos/${owner}/${repo}/git/refs/heads/${refPath}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: githubHeaders(),
  });
  return { success: response.status === 204, status: response.status };
}

/**
 * Delete a branch on GitHub with retry.
 *
 * A squash merge invalidates the branch ref immediately after completion,
 * and GitHub can return a transient 409 if a ref-update is still in flight
 * at the moment we send the DELETE. Retrying with a short delay resolves
 * that race in practice.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @param {number} [maxRetries=2] — total extra attempts after the first failure
 * @returns {Promise<{ success: boolean, status: number, attempted: number }>}
 */
async function githubDeleteBranchWithRetry(owner, repo, branch, maxRetries = 2) {
  let lastResult = { success: false, status: 0 };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(GITHUB_DELETE_RETRY_DELAY_MS);
    }
    try {
      lastResult = await githubDeleteBranch(owner, repo, branch);
      if (lastResult.success) {
        return { ...lastResult, attempted: attempt + 1 };
      }
    } catch (err) {
      lastResult = { success: false, status: -1, err };
    }
  }
  return { ...lastResult, attempted: maxRetries + 1 };
}

/**
 * Full GitHub merge flow: squash → merge → rebase fallback.
 * Retries up to 2 times on transient failures per method.
 *
 * Before attempting the merge, GETs the PR and inspects `mergeable_state` to
 * determine whether/when the PR can be merged:
 *   - 'dirty'                 → merge_conflict (don't attempt merge)
 *   - 'blocked' / 'behind'    → rejected_by_policy (don't attempt merge)
 *   - 'unknown'               → poll GET until it resolves; not_ready if exhausted
 *   - 'clean'/'has_hooks'/'unstable'/null → proceed with merge
 */
async function completeGitHubPr(owner, repo, number, branch) {
  // ---------------------------------------------------------------------------
  // Step 1: GET the PR and check mergeable_state before attempting the merge.
  // 'unknown' means GitHub is still computing mergeability asynchronously —
  // poll until it resolves (up to MAX_UNKNOWN_POLLS attempts with
  // UNKNOWN_POLL_INTERVAL_MS delay) rather than racing that computation.
  // ---------------------------------------------------------------------------
  const MAX_UNKNOWN_POLLS = 3;
  const UNKNOWN_POLL_INTERVAL_MS = GITHUB_UNKNOWN_POLL_INTERVAL_MS;

  let mergeableState = undefined;

  for (let poll = 0; poll <= MAX_UNKNOWN_POLLS; poll++) {
    if (poll > 0) {
      await sleep(UNKNOWN_POLL_INTERVAL_MS);
    }

    try {
      const pr = await githubGetPr(owner, repo, number);
      if (pr.ok) {
        mergeableState = pr.mergeableState;
      }
    } catch {
      // Non-fatal — proceed without mergeable_state
      mergeableState = undefined;
    }

    if (mergeableState !== "unknown") {
      break;
    }
    // Still 'unknown' — wait and re-poll (unless we've hit the limit)
  }

  // Inspect mergeable_state and return early for terminal non-ready states.
  if (mergeableState === "dirty") {
    return {
      success: false,
      error: "merge_conflict",
      message: "PR has merge conflicts that must be resolved before merging.",
    };
  }

  if (mergeableState === "blocked" || mergeableState === "behind") {
    return {
      success: false,
      error: "rejected_by_policy",
      message:
        mergeableState === "behind"
          ? "PR is behind the base branch and blocked by branch protection (update required before merging)."
          : "PR is blocked by branch protection (required reviews or status checks not satisfied).",
    };
  }

  if (mergeableState === "unknown") {
    // Still 'unknown' after all polls — GitHub hasn't finished computing mergeability
    return {
      success: false,
      error: "not_ready",
      message: "PR mergeability is still being computed by GitHub (mergeable_state: unknown). Try again shortly.",
    };
  }

  // mergeable_state is 'clean', 'has_hooks', 'unstable', or unknown/null — proceed with merge.

  const methods = ["squash", "merge", "rebase"];

  for (const method of methods) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await githubMergePr(owner, repo, number, method);

      if (result.success) {
        // Merge succeeded — attempt to delete the branch
        if (branch) {
          try {
            // Skip deletion if the branch is still referenced by another active task.
            // Deleting now would destroy a branch a sibling/future task still needs.
            if (BRANCH_HAS_ACTIVE_TASKS === "true") {
              return {
                success: true,
                message: `PR #${number} merged successfully (method: ${method}). Branch "${branch}" was not deleted because it is still referenced by another active task.`,
              };
            }

            const deleteResult = await githubDeleteBranchWithRetry(owner, repo, branch);
            if (deleteResult.success) {
              return {
                success: true,
                message: `PR #${number} merged successfully (method: ${method}). Branch "${branch}" deleted.`,
              };
            }
            // Delete failed after all retries — surface this clearly rather than
            // swallowing it in a success:true message. The orchestrator/QA agent
            // must know the branch still exists so a human can clean it up.
            return {
              success: false,
              error: "branch_delete_failed",
              message: `PR #${number} merged successfully (method: ${method}), but branch "${branch}" could not be deleted after ${deleteResult.attempted} attempt(s) (HTTP ${deleteResult.status}). Please delete the branch manually.`,
            };
          } catch (err) {
            // Network error during delete — also a clear failure, not a silent swallow
            return {
              success: false,
              error: "branch_delete_failed",
              message: `PR #${number} merged successfully (method: ${method}), but branch "${branch}" could not be deleted (${err?.message || "unknown error"}). Please delete the branch manually.`,
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
 *
 * Before attempting the PATCH, GETs the PR and inspects `mergeStatus` to
 * determine whether/when the PR can be completed:
 *   - 'conflicts'        → merge_conflict (don't attempt PATCH)
 *   - 'rejectedByPolicy' → rejected_by_policy (don't attempt PATCH)
 *   - 'failure'          → merge_failed (don't attempt PATCH)
 *   - 'queued'           → retry GET until status resolves; not_ready if exhausted
 *   - 'succeeded'/'notSet' → proceed with PATCH
 */
async function completeAzureDevOpsPr(org, project, repo, prId) {
  const prApiUrl =
    `${AZURE_DEVOPS_BASE_URL}/${encodeURIComponent(org)}/${encodeURIComponent(project)}` +
    `/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}` +
    `?api-version=7.1`;

  // ---------------------------------------------------------------------------
  // Step 1: GET the PR and check mergeStatus before attempting PATCH.
  // 'queued' means Azure DevOps is still computing the merge — poll until it
  // resolves (up to MAX_QUEUED_POLLS attempts with QUEUED_POLL_INTERVAL_MS delay).
  // ---------------------------------------------------------------------------
  const MAX_QUEUED_POLLS = 3;
  const QUEUED_POLL_INTERVAL_MS = AZURE_DEVOPS_QUEUED_POLL_INTERVAL_MS;

  let prData = null;
  let mergeStatus = null;
  let lastMergeSourceCommit = undefined;

  for (let poll = 0; poll <= MAX_QUEUED_POLLS; poll++) {
    if (poll > 0) {
      await sleep(QUEUED_POLL_INTERVAL_MS);
    }

    try {
      const getResponse = await fetch(prApiUrl, { method: "GET", headers: azureDevOpsHeaders() });
      if (getResponse.ok) {
        prData = await getResponse.json();
        mergeStatus = prData.mergeStatus;
        lastMergeSourceCommit = prData.lastMergeSourceCommit;
      }
    } catch {
      // Non-fatal — proceed without mergeStatus
    }

    if (mergeStatus !== "queued") {
      break;
    }
    // Still queued — wait and re-poll (unless we've hit the limit)
  }

  // Inspect mergeStatus and return early for terminal non-ready states.
  if (mergeStatus === "conflicts") {
    return {
      success: false,
      error: "merge_conflict",
      message: "PR has merge conflicts that must be resolved before completing.",
    };
  }

  if (mergeStatus === "rejectedByPolicy") {
    return {
      success: false,
      error: "rejected_by_policy",
      message: "PR completion was rejected by a branch policy. Review the policy requirements and try again.",
    };
  }

  if (mergeStatus === "failure") {
    return {
      success: false,
      error: "merge_failed",
      message: "PR merge failed (mergeStatus: failure). Check the PR for details.",
    };
  }

  if (mergeStatus === "queued") {
    // Still queued after all polls — Azure DevOps hasn't finished computing
    return {
      success: false,
      error: "not_ready",
      message: "PR merge status is still being computed (mergeStatus: queued). Try again shortly.",
    };
  }

  // mergeStatus is 'succeeded', 'notSet', or unknown/null — proceed with PATCH.

  // ---------------------------------------------------------------------------
  // Step 2: PATCH to complete the PR.
  // Falls back from squash to noFastForward if squash is disallowed (400).
  // On failure, does NOT infer conflict from 409 message text — the pre-check
  // already validated mergeStatus, so a 409 here indicates a different condition.
  //
  // If BRANCH_HAS_ACTIVE_TASKS is "true", the branch is still referenced by another
  // active task — request Azure DevOps to NOT delete the source branch.
  // ---------------------------------------------------------------------------
  const shouldDeleteBranch = BRANCH_HAS_ACTIVE_TASKS !== "true";
  const strategies = ["squash", "noFastForward"];

  for (const strategy of strategies) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = {
        status: "completed",
        lastMergeSourceCommit,
        completionOptions: {
          deleteSourceBranch: shouldDeleteBranch,
          mergeStrategy: strategy,
        },
      };

      const response = await fetch(prApiUrl, {
        method: "PATCH",
        headers: azureDevOpsHeaders(),
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const branchNote = shouldDeleteBranch
          ? "Source branch deleted."
          : "Source branch was not deleted because it is still referenced by another active task.";
        return {
          success: true,
          message: `PR #${prId} completed successfully (strategy: ${strategy}). ${branchNote}`,
        };
      }

      const responseBody = await response.json().catch(() => ({}));

      // 409: do NOT infer conflict from message text — mergeStatus pre-check
      // already determined mergeStatus was ready. This 409 reflects some other
      // Azure DevOps condition (e.g. PR already completed, concurrent completion).
      if (response.status === 409) {
        return {
          success: false,
          error: "merge_failed",
          message: `Azure DevOps 409 during PATCH: ${responseBody?.message || "Completion failed."}`,
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
      // merge_conflict and rejected_by_policy are not MCP errors — the agent can act on them.
      // not_ready and merge_failed are MCP errors (unexpected/terminal conditions).
      const isActionable = result.error === "merge_conflict" || result.error === "rejected_by_policy";
      respond(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: result.error, message: result.message }),
          },
        ],
        isError: !isActionable,
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
      // merge_conflict and rejected_by_policy are not MCP errors — the agent can act on them.
      // not_ready and merge_failed are MCP errors (unexpected/terminal conditions).
      const isActionable = result.error === "merge_conflict" || result.error === "rejected_by_policy";
      respond(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: result.error, message: result.message }),
          },
        ],
        isError: !isActionable,
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

#!/usr/bin/env node
/**
 * Git Delivery MCP Server — Lightweight stdio MCP server exposing tools for
 * agent-driven commit, push, and PR creation/update.
 *
 * Allows the dev agent to drive git delivery itself via MCP tools instead of
 * the worker doing it blindly after the turn ends. Credentials are NEVER
 * exposed as tool-call inputs or outputs — they are read exclusively from
 * environment variables set by the worker.
 *
 * Environment variables (set by worker.js's buildMcpServers()):
 *   WORKSPACE           — Path to the git workspace (clone root)
 *   TASK_BRANCH_NAME    — Deterministic branch name ([type]/#[id]_[slug])
 *   DEV_BRANCH          — Base/target branch name (e.g. "develop")
 *   TASK_ID             — Numeric task ID
 *   TASK_TITLE          — Task title (for default PR content)
 *   TASK_DESCRIPTION    — Task description (for default PR body)
 *   TASK_TYPE           — Task type (bug/feature/improvement)
 *   TASK_PR_URL         — Existing PR URL (empty if none yet)
 *   REPO_URL            — Repository URL (for provider detection + API calls)
 *   GIT_PROVIDER        — "github" | "azure-devops" (or auto-detected from URL)
 *   GITHUB_PAT          — GitHub Personal Access Token
 *   AZURE_DEVOPS_PAT    — Azure DevOps Personal Access Token
 *   DELIVERY_RESULT_PATH — Path to write the delivery result JSON
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (MCP stdio transport).
 */

import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const SERVER_NAME = "git-delivery-mcp-server";
const SERVER_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const WORKSPACE = process.env.WORKSPACE || "/workspace";
// .replace() strips any embedded newline/tab/CR and .trim() removes leading/
// trailing whitespace — defense-in-depth against a malformed branch value
// reaching a `git checkout -B <name>` call (which fails on invalid refs).
// The primary fix is sanitizing at the DB write sites (resolveTask/resetTask/
// setTaskBranchAndPr in the backend), but this env var is also the one place
// a pre-existing corrupted DB row, or any future path that sets this env var
// without going through those writers, would otherwise reach an actual git
// invocation unsanitized.
const TASK_BRANCH_NAME = (process.env.TASK_BRANCH_NAME || "").replace(/[\r\n\t]+/g, "").trim();
const DEV_BRANCH = process.env.DEV_BRANCH || "develop";
const TASK_ID = process.env.TASK_ID || "";
const TASK_TITLE = process.env.TASK_TITLE || "";
const TASK_DESCRIPTION = process.env.TASK_DESCRIPTION || "";
const TASK_TYPE = process.env.TASK_TYPE || "task";
const REPO_URL = process.env.REPO_URL || "";
const GIT_PROVIDER = process.env.GIT_PROVIDER || "";
const GITHUB_PAT = process.env.GITHUB_PAT || "";
const AZURE_DEVOPS_PAT = process.env.AZURE_DEVOPS_PAT || "";
const DELIVERY_RESULT_PATH = process.env.DELIVERY_RESULT_PATH || "";

/**
 * Read TASK_PR_URL at call time (not module load) — worker sets it in
 * process.env after receiving task metadata from the orchestrator.
 */
function getTaskPrUrl() {
  return process.env.TASK_PR_URL || "";
}

// ---------------------------------------------------------------------------
// Helpers — git execution (mirrors worker.js patterns)
// ---------------------------------------------------------------------------

/**
 * Redact secrets from text to prevent PAT leakage in any output.
 */
function redactSecrets(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text.replace(/(https?:\/\/)[^@\s/"']+@/g, "$1***@");
  for (const secret of [GITHUB_PAT, AZURE_DEVOPS_PAT]) {
    if (secret && secret.length >= 8) out = out.split(secret).join("***");
  }
  return out;
}

/**
 * Run a git command with explicit argv array (no shell parsing).
 */
function execGit(args, opts = {}) {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      timeout: 120_000,
      cwd: WORKSPACE,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      ...opts,
    }).trim();
  } catch (err) {
    if (err && typeof err.message === "string") err.message = redactSecrets(err.message);
    throw err;
  }
}

/**
 * Push HEAD to `refs/heads/<branchName>` on `remote`, automatically
 * recovering from non-fast-forward rejections by fetching and rebasing onto
 * the moved remote tip before retrying.
 *
 * Mirrors worker.js's pushWithRebaseRetry(): a non-fast-forward rejection
 * means the remote branch advanced after this workspace last synced — e.g.
 * a second run against the same task (editor -> review comment -> editor
 * again) or resolve_review_comment/finalize_branch_sync writing to the
 * branch between this call's last sync and its push. That is a recoverable
 * race, not a credential/permission problem — the caller upstream
 * (worker.js/session-manager.ts) treats any push failure after a successful
 * commit as `deliveryFailed` and permanently blocks the task for the rest
 * of the session on the assumption retrying can't help, which is only true
 * for real auth/permission errors. Without this retry, submit_task_changes
 * had no equivalent of worker.js's own recovery and could fail a task
 * outright on a transient, self-resolvable race.
 *
 * A genuine auth/permission error (bad PAT, no write access, unknown host)
 * produces a different git error and is returned immediately without
 * retrying, so it still surfaces (and blocks) as the real problem it is.
 */
function pushWithRebaseRetry(remote, branchName, maxAttempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      execGit(["push", remote, `HEAD:refs/heads/${branchName}`]);
      return { pushed: true };
    } catch (err) {
      const pushError = redactSecrets(err?.message || String(err));
      lastError = pushError;

      const isNonFastForward = /\[rejected\]|non-fast-forward|fetch first|behind its remote/i.test(pushError);
      if (!isNonFastForward || attempt === maxAttempts) {
        return { pushed: false, pushError };
      }

      try {
        execGit(["fetch", remote, branchName]);
        // FETCH_HEAD, not refs/remotes/origin/<branch> — fetching from a raw
        // authenticated URL (not the "origin" remote name) only updates
        // FETCH_HEAD.
        execGit(["rebase", "FETCH_HEAD"]);
      } catch (rebaseErr) {
        // A real conflict (or fetch failure) needs a human/agent to resolve,
        // not a blind retry — abort so the workspace isn't left mid-rebase,
        // and surface both errors together for diagnosis.
        try {
          execGit(["rebase", "--abort"]);
        } catch { /* no rebase in progress */ }
        const rebaseError = redactSecrets(rebaseErr?.message || String(rebaseErr));
        return { pushed: false, pushError: `${pushError} (rebase retry failed: ${rebaseError})` };
      }
    }
  }

  return { pushed: false, pushError: lastError };
}

// ---------------------------------------------------------------------------
// Provider detection & URL helpers (mirrors worker.js)
// ---------------------------------------------------------------------------

function detectProvider() {
  if (GIT_PROVIDER === "github" || GIT_PROVIDER === "azure-devops") return GIT_PROVIDER;
  if (REPO_URL.includes("github.com")) return "github";
  if (REPO_URL.includes("dev.azure.com") || REPO_URL.includes("visualstudio.com"))
    return "azure-devops";
  return "unknown";
}

/** Remove any `user@` / `user:pass@` part already present in a URL. */
function stripUserInfo(url) {
  return url.replace(/^(https?:\/\/)[^@/]+@/, "$1");
}

/**
 * Build an authenticated remote URL for push operations.
 * Never exposed to the agent — only used internally for git push.
 */
function buildAuthRemoteUrl() {
  if (!REPO_URL) return "origin";
  const base = stripUserInfo(REPO_URL);
  const provider = detectProvider();
  switch (provider) {
    case "azure-devops":
      return AZURE_DEVOPS_PAT
        ? base.replace("https://", `https://pat:${AZURE_DEVOPS_PAT}@`)
        : base;
    case "github":
      return GITHUB_PAT
        ? base.replace("https://", `https://x-access-token:${GITHUB_PAT}@`)
        : base;
    default:
      return base;
  }
}

function parseGitHubRepo(url) {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function parseAzureDevOpsRepo(url) {
  const modern = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/);
  if (modern) return { org: modern[1], project: modern[2], repo: modern[3].replace(/\.git$/, "") };
  const legacy = url.match(/([^/.@]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/?#]+)/);
  if (legacy) return { org: legacy[1], project: legacy[2], repo: legacy[3].replace(/\.git$/, "") };
  return null;
}

function parsePrNumber(url) {
  const ghMatch = url.match(/\/pull\/(\d+)/);
  if (ghMatch) return parseInt(ghMatch[1], 10);
  const adoMatch = url.match(/\/pullrequest\/(\d+)/);
  if (adoMatch) return parseInt(adoMatch[1], 10);
  return null;
}

// ---------------------------------------------------------------------------
// GitHub API helpers (mirrors worker.js patterns)
// ---------------------------------------------------------------------------

function githubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function createGitHubPullRequest(branchName, title, body) {
  const parsed = parseGitHubRepo(REPO_URL);
  if (!parsed) throw new Error(`Cannot parse owner/repo from REPO_URL: "${redactSecrets(REPO_URL)}"`);
  const { owner, repo } = parsed;

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: githubHeaders(),
    body: JSON.stringify({
      title,
      body,
      head: branchName,
      base: DEV_BRANCH,
    }),
  });

  if (response.status === 201) {
    const data = await response.json();
    return data.html_url;
  }

  const errorData = await response.json().catch(() => ({}));

  // 422 = PR already exists for this branch
  if (response.status === 422) {
    const existingUrl = await fetchExistingGitHubPr(owner, repo, branchName);
    if (existingUrl) {
      await updateGitHubPullRequest(existingUrl, title, body);
      return existingUrl;
    }
  }

  throw new Error(`GitHub PR creation failed: ${response.status} ${errorData.message || ""}`);
}

async function fetchExistingGitHubPr(owner, repo, branchName) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branchName)}&per_page=1`;
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) return null;
  const data = await response.json();
  return Array.isArray(data) && data.length > 0 ? data[0].html_url : null;
}

async function updateGitHubPullRequest(prUrl, title, body) {
  const prMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!prMatch) return;
  const [, owner, repo, prNumber] = prMatch;

  await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    method: "PATCH",
    headers: githubHeaders(),
    body: JSON.stringify({ title, body }),
  });
}

// ---------------------------------------------------------------------------
// Azure DevOps API helpers (mirrors worker.js patterns)
// ---------------------------------------------------------------------------

function adoHeaders() {
  return {
    Authorization: `Basic ${Buffer.from(`:${AZURE_DEVOPS_PAT}`).toString("base64")}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function createAzureDevOpsPullRequest(branchName, title, body) {
  const parsed = parseAzureDevOpsRepo(REPO_URL);
  if (!parsed) throw new Error(`Cannot parse org/project/repo from REPO_URL: "${redactSecrets(REPO_URL)}"`);
  const { org, project, repo } = parsed;

  const description = body.length > 4000 ? `${body.slice(0, 3990)}\n…` : body;
  const apiUrl =
    `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}` +
    `/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests?api-version=7.1`;

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: adoHeaders(),
    body: JSON.stringify({
      sourceRefName: `refs/heads/${branchName}`,
      targetRefName: `refs/heads/${DEV_BRANCH}`,
      title,
      description,
    }),
  });

  if (response.status === 200 || response.status === 201) {
    const data = await response.json();
    return (
      data?._links?.web?.href ||
      (data?.repository?.webUrl && data?.pullRequestId
        ? `${data.repository.webUrl}/pullrequest/${data.pullRequestId}`
        : null)
    );
  }

  const errorData = await response.json().catch(() => ({}));

  // 409 = PR already exists
  if (response.status === 409) {
    const existingUrl = await fetchExistingAzureDevOpsPr(org, project, repo, branchName);
    if (existingUrl) {
      await updateAzureDevOpsPullRequest(existingUrl, title, body);
      return existingUrl;
    }
  }

  throw new Error(`Azure DevOps PR creation failed: ${response.status} ${errorData.message || ""}`);
}

async function fetchExistingAzureDevOpsPr(org, project, repo, branchName) {
  const apiUrl =
    `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}` +
    `/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests` +
    `?searchCriteria.sourceRefName=refs/heads/${encodeURIComponent(branchName)}` +
    `&searchCriteria.status=active&$top=1&api-version=7.1`;

  const response = await fetch(apiUrl, { headers: adoHeaders() });
  if (!response.ok) return null;
  const data = await response.json();
  const prs = data?.value;
  if (Array.isArray(prs) && prs.length > 0) {
    const pr = prs[0];
    return (
      pr?._links?.web?.href ||
      (pr?.repository?.webUrl && pr?.pullRequestId
        ? `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`
        : null)
    );
  }
  return null;
}

async function updateAzureDevOpsPullRequest(prUrl, title, body) {
  const parsed = parseAzureDevOpsRepo(REPO_URL);
  if (!parsed) return;
  const { org, project, repo } = parsed;

  const prIdMatch = prUrl.match(/pullrequest\/(\d+)/);
  if (!prIdMatch) return;
  const prId = prIdMatch[1];

  const description = body.length > 4000 ? `${body.slice(0, 3990)}\n…` : body;
  const apiUrl =
    `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}` +
    `/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}?api-version=7.1`;

  await fetch(apiUrl, {
    method: "PATCH",
    headers: adoHeaders(),
    body: JSON.stringify({ title, description }),
  });
}

// ---------------------------------------------------------------------------
// Tool: sync_task_branch
// ---------------------------------------------------------------------------

async function handleSyncTaskBranch() {
  if (!TASK_BRANCH_NAME) {
    return { success: false, error: "TASK_BRANCH_NAME environment variable is not set." };
  }
  if (!DEV_BRANCH) {
    return { success: false, error: "DEV_BRANCH environment variable is not set." };
  }

  const remote = buildAuthRemoteUrl();

  // Check if the task branch exists on the remote
  let branchExistsRemotely = false;
  try {
    const lsRemote = execGit(["ls-remote", "--heads", remote, TASK_BRANCH_NAME]);
    branchExistsRemotely = Boolean(lsRemote.trim());
  } catch {
    branchExistsRemotely = false;
  }

  if (!branchExistsRemotely) {
    // Create branch from DEV_BRANCH
    try {
      execGit(["fetch", remote, DEV_BRANCH]);
      execGit(["checkout", "-B", TASK_BRANCH_NAME, "FETCH_HEAD"]);
      return { success: true, branchName: TASK_BRANCH_NAME, hadConflicts: false };
    } catch (err) {
      return { success: false, error: `Failed to create branch from ${DEV_BRANCH}: ${redactSecrets(err?.message || String(err))}` };
    }
  }

  // Branch exists remotely — fetch it and DEV_BRANCH, then merge
  try {
    execGit(["fetch", remote, TASK_BRANCH_NAME]);
    execGit(["checkout", "-B", TASK_BRANCH_NAME, "FETCH_HEAD"]);
    execGit(["fetch", remote, DEV_BRANCH]);
  } catch (err) {
    return { success: false, error: `Failed to fetch branches: ${redactSecrets(err?.message || String(err))}` };
  }

  // Attempt merge of DEV_BRANCH into task branch
  try {
    execGit(["merge", "FETCH_HEAD", "--no-edit"]);
    // Clean merge
    return { success: true, branchName: TASK_BRANCH_NAME, hadConflicts: false };
  } catch {
    // Check if this is a merge conflict (not some other git error)
    try {
      const conflicted = execGit(["diff", "--name-only", "--diff-filter=U"]);
      if (conflicted) {
        const conflictedFiles = conflicted.split("\n").filter(Boolean);
        return {
          success: true,
          branchName: TASK_BRANCH_NAME,
          hadConflicts: true,
          conflictedFiles,
          message:
            "Merge conflicts detected. Resolve the conflicts in the listed files by " +
            "editing them to remove conflict markers (<<<<<<< / ======= / >>>>>>>), then " +
            "call finalize_branch_sync to complete the merge.",
        };
      }
    } catch { /* fall through */ }

    // Not a conflict — something else went wrong
    return { success: false, error: `Merge of ${DEV_BRANCH} into ${TASK_BRANCH_NAME} failed unexpectedly.` };
  }
}

// ---------------------------------------------------------------------------
// Tool: finalize_branch_sync
// ---------------------------------------------------------------------------

async function handleFinalizeBranchSync() {
  // Check if there's actually a merge in progress
  try {
    const mergeHead = execGit(["rev-parse", "--verify", "MERGE_HEAD"]);
    if (!mergeHead) {
      return { success: false, error: "No merge in progress. Call sync_task_branch first if you need to sync." };
    }
  } catch {
    return { success: false, error: "No merge in progress. Call sync_task_branch first if you need to sync." };
  }

  // Stage all files first — the agent may have resolved conflicts by editing
  // files, but git still considers them "unmerged" until they are staged.
  try {
    execGit(["add", "-A"]);
  } catch (err) {
    return { success: false, error: `Failed to stage files: ${redactSecrets(err?.message || String(err))}` };
  }

  // Check if any tracked files still contain literal conflict markers
  // (the real check — file content, not git's unmerged state).
  // Uses `git grep` to only search tracked files, avoiding false positives
  // from .git/ internals or node_modules/ test fixtures.
  try {
    const grepResult = execGit(
      ["grep", "-l", "^<<<<<<<\\|^=======\\|^>>>>>>>", "--", ".", ":!node_modules"],
    );
    if (grepResult) {
      const files = grepResult.split("\n").filter(Boolean).slice(0, 10);
      return {
        success: false,
        error: `Cannot finalize: conflict markers still present in: ${files.join(", ")}. ` +
          "Finish resolving all conflicts by removing <<<<<<< / ======= / >>>>>>> markers, then call finalize_branch_sync again.",
      };
    }
  } catch {
    // git grep returns exit code 1 when no matches found — that's the success case
  }

  // Commit the merge
  try {
    execGit(["commit", "--no-edit"]);
    return { success: true, message: "Merge completed successfully." };
  } catch (err) {
    return { success: false, error: `Failed to complete merge: ${redactSecrets(err?.message || String(err))}` };
  }
}

// ---------------------------------------------------------------------------
// Tool: submit_task_changes
// ---------------------------------------------------------------------------

async function handleSubmitTaskChanges(args) {
  const { title, body } = args;

  // Check for changes
  let status = "";
  try {
    status = execGit(["status", "--porcelain"]);
  } catch (err) {
    const result = { committed: false, pushed: false, error: `Not a git workspace: ${redactSecrets(err?.message || String(err))}` };
    writeDeliveryResult(result);
    return result;
  }

  if (!status) {
    // No uncommitted changes — but there may be already-committed changes
    // that failed to push on a prior call (e.g., transient network error).
    // Check if the local branch is ahead of the remote and attempt a push.
    const branchName = TASK_BRANCH_NAME || execGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    let localAhead = false;
    try {
      const ahead = execGit(["rev-list", `origin/${branchName}..HEAD`]);
      localAhead = Boolean(ahead.trim());
    } catch {
      // origin/branchName may not exist yet — check if we're on the task branch
      try {
        const currentBranch = execGit(["rev-parse", "--abbrev-ref", "HEAD"]);
        localAhead = currentBranch === branchName;
      } catch { /* noop */ }
    }

    if (localAhead) {
      // Attempt push of existing commits
      const remote = buildAuthRemoteUrl();
      const pushResult = pushWithRebaseRetry(remote, branchName);
      const pushed = pushResult.pushed;
      let pushError = pushResult.pushError || null;

      // Handle PR creation/update after successful push
      let prUrl = getTaskPrUrl();
      let prCreated = false;

      if (pushed) {
        const provider = detectProvider();

        if (!prUrl) {
          const prTitle = `${title} [KiroFactory #${TASK_ID}]`;
          const prBody = body || buildDefaultPrBody();

          try {
            if (provider === "github" && GITHUB_PAT) {
              prUrl = await createGitHubPullRequest(branchName, prTitle, prBody);
              prCreated = true;
            } else if (provider === "azure-devops" && AZURE_DEVOPS_PAT) {
              prUrl = await createAzureDevOpsPullRequest(branchName, prTitle, prBody);
              prCreated = true;
            }
            if (prCreated && prUrl) {
              process.env.TASK_PR_URL = prUrl;
            }
          } catch (err) {
            pushError = `Push succeeded but PR creation failed: ${redactSecrets(err?.message || String(err))}`;
          }
        } else {
          const prTitle = `${title} [KiroFactory #${TASK_ID}]`;
          const prBody = body || buildDefaultPrBody();

          try {
            if (provider === "github" && GITHUB_PAT) {
              await updateGitHubPullRequest(prUrl, prTitle, prBody);
            } else if (provider === "azure-devops" && AZURE_DEVOPS_PAT) {
              await updateAzureDevOpsPullRequest(prUrl, prTitle, prBody);
            }
          } catch {
            // Update failure is non-fatal
          }
        }
      }

      const result = {
        committed: true,
        pushed,
        branchName,
        prUrl: prUrl || null,
        prCreated,
        error: pushError || undefined,
        message: "No new changes to commit; pushed existing unpushed commits.",
      };
      writeDeliveryResult(result);
      return result;
    }

    const result = { committed: false, pushed: false, branchName, message: "No changes to commit." };
    writeDeliveryResult(result);
    return result;
  }

  // Stage all changes
  execGit(["add", "-A"]);

  // Build commit message (mirrors worker.js commitAndPush() format)
  const commitTitle = `${title} [Vibecode Heaven #${TASK_ID}]`;
  const commitBody = body
    ? `\nType: ${TASK_TYPE}\nID: ${TASK_ID}\n\n${body}`
    : `\nType: ${TASK_TYPE}\nID: ${TASK_ID}\n\n${TASK_DESCRIPTION || ""}`;

  try {
    execGit(["commit", "-m", `${commitTitle}${commitBody}`]);
  } catch (err) {
    const result = { committed: false, pushed: false, error: `Commit failed: ${redactSecrets(err?.message || String(err))}` };
    writeDeliveryResult(result);
    return result;
  }

  // Push to the authenticated remote
  const remote = buildAuthRemoteUrl();
  const branchName = TASK_BRANCH_NAME || execGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const pushResult = pushWithRebaseRetry(remote, branchName);
  const pushed = pushResult.pushed;
  let pushError = pushResult.pushError || null;

  // Handle PR creation/update
  let prUrl = getTaskPrUrl();
  let prCreated = false;

  if (pushed) {
    const provider = detectProvider();

    if (!prUrl) {
      // No existing PR — create one
      const prTitle = `${title} [KiroFactory #${TASK_ID}]`;
      const prBody = body || buildDefaultPrBody();

      try {
        if (provider === "github" && GITHUB_PAT) {
          prUrl = await createGitHubPullRequest(branchName, prTitle, prBody);
          prCreated = true;
        } else if (provider === "azure-devops" && AZURE_DEVOPS_PAT) {
          prUrl = await createAzureDevOpsPullRequest(branchName, prTitle, prBody);
          prCreated = true;
        }
        // Cache the PR URL so subsequent calls in the same session go
        // straight to the update path instead of re-attempting creation.
        if (prCreated && prUrl) {
          process.env.TASK_PR_URL = prUrl;
        }
      } catch (err) {
        // PR creation failure is non-fatal — the push succeeded
        pushError = `Push succeeded but PR creation failed: ${redactSecrets(err?.message || String(err))}`;
      }
    } else {
      // PR exists — update title/body
      const prTitle = `${title} [KiroFactory #${TASK_ID}]`;
      const prBody = body || buildDefaultPrBody();

      try {
        if (provider === "github" && GITHUB_PAT) {
          await updateGitHubPullRequest(prUrl, prTitle, prBody);
        } else if (provider === "azure-devops" && AZURE_DEVOPS_PAT) {
          await updateAzureDevOpsPullRequest(prUrl, prTitle, prBody);
        }
      } catch {
        // Update failure is non-fatal
      }
    }
  }

  const result = {
    committed: true,
    pushed,
    branchName,
    prUrl: prUrl || null,
    prCreated,
    error: pushError || undefined,
  };

  writeDeliveryResult(result);
  return result;
}

/**
 * Build default PR body from task metadata (mirrors worker.js buildPrContent).
 */
function buildDefaultPrBody() {
  return [
    "## Task",
    "",
    `**Title:** ${TASK_TITLE || `Task ${TASK_ID}`}`,
    `**Type:** ${TASK_TYPE}`,
    `**ID:** ${TASK_ID}`,
    "",
    "## Description",
    "",
    TASK_DESCRIPTION || "_(no description provided)_",
    "",
    "---",
    "*Created automatically by KiroFactory*",
  ].join("\n");
}

/**
 * Write delivery result to DELIVERY_RESULT_PATH (if configured).
 * Never includes secrets in the output.
 */
function writeDeliveryResult(result) {
  if (!DELIVERY_RESULT_PATH) return;
  try {
    // Ensure no secrets leak into the result file
    const safeResult = { ...result };
    if (safeResult.error) safeResult.error = redactSecrets(safeResult.error);
    if (safeResult.prUrl) safeResult.prUrl = redactSecrets(safeResult.prUrl);
    writeFileSync(DELIVERY_RESULT_PATH, JSON.stringify(safeResult, null, 2));
  } catch {
    // Best-effort — don't crash the tool call over a file write failure
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "sync_task_branch",
    description:
      "Ensure the task's branch is up to date with the base branch. Creates the branch " +
      "from DEV_BRANCH if it doesn't exist yet, or fetches and merges DEV_BRANCH into it " +
      "if it does. On merge conflicts, leaves conflict markers in the working tree for you " +
      "to resolve, then call finalize_branch_sync to complete the merge.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "finalize_branch_sync",
    description:
      "Complete a merge left mid-conflict by sync_task_branch. Stage the resolved files " +
      "and commit the merge. Call this after resolving all conflict markers. If conflict " +
      "markers still remain, this will fail with a message telling you to finish resolving first.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "submit_task_changes",
    description:
      "Commit all current changes, push to the task branch, and create or update the pull " +
      "request. If nothing is staged/modified, returns a no-changes result (not an error). " +
      "The commit message includes the task ID automatically.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Commit title / PR title (required). Keep it concise — the task ID is appended automatically.",
        },
        body: {
          type: "string",
          description:
            "Optional commit body / PR description. If omitted, defaults to the task's description.",
        },
      },
      required: ["title"],
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC helpers (same pattern as pr-review-mcp-server.js)
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

  try {
    switch (toolName) {
      case "sync_task_branch": {
        const result = await handleSyncTaskBranch();
        respond(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        break;
      }
      case "finalize_branch_sync": {
        const result = await handleFinalizeBranchSync();
        respond(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        break;
      }
      case "submit_task_changes": {
        if (!args.title || typeof args.title !== "string") {
          respond(id, {
            content: [{ type: "text", text: 'Error: "title" is required and must be a non-empty string.' }],
            isError: true,
          });
          return;
        }
        const result = await handleSubmitTaskChanges(args);
        // Flag as an MCP error only for fatal failures (not a git workspace,
        // commit failed, push failed). Partial success (pushed ok but PR
        // creation failed) keeps the full result JSON so the agent can act on it.
        if (result.error && typeof result.error === "string" && !result.pushed) {
          respond(id, {
            content: [{ type: "text", text: `Error: ${result.error}` }],
            isError: true,
          });
        } else {
          respond(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        }
        break;
      }
      default:
        respondError(id, -32602, `Unknown tool: ${toolName}`);
        break;
    }
  } catch (err) {
    respond(id, {
      content: [{ type: "text", text: `Error: ${redactSecrets(err?.message || String(err))}` }],
      isError: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Stdio transport (same pattern as other MCP servers)
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, terminal: false });

let pendingOps = 0;
let closing = false;

function maybeExit() {
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
        maybeExit();
      }
    }
    // Notifications (no id) — ignore silently
  } catch {
    // Non-JSON line — ignore
  }
});

rl.on("close", () => {
  closing = true;
  maybeExit();
});

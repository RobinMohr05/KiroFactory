/**
 * Local Git Delivery — Per-task git-delivery/pr-review MCP server builders
 * for local (non-ACA) loop-mode sessions.
 *
 * `worker/worker.js`'s `buildMcpServers()` injects `git-delivery` (commit/
 * push/PR tools) and `pr-review` (PR comment read/resolve tools) for the
 * ACA/hosted path — see that function's own comments for the full rationale
 * of each server. Both underlying scripts (`worker/git-delivery-mcp-server.js`,
 * `worker/pr-review-mcp-server.js`) are plain Node stdio MCP servers driven
 * entirely by environment variables and `execFileSync`/`fetch` — nothing
 * ACA/container-specific about them — so they can be spawned identically by
 * a local `KiroRunner` session. This module builds the exact same env var
 * sets so tool behavior is identical between hosted and local sessions;
 * only the transport (direct stdio child process here vs. inside an ACA
 * container there) differs.
 */

import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { McpServerEntry } from "./kiro-runner.js";
import type { GitProvider } from "../types.js";

const WORKER_DIR = resolve(import.meta.dirname, "../../../worker");

/** Git identity + credentials resolved once per local loop-mode session. */
export interface LocalGitDeliveryContext {
  repositoryUrl: string;
  gitProvider: GitProvider | null;
  devBranch: string;
  githubPat?: string;
  azureDevOpsPat?: string;
}

/** Per-task fields only known once a task has been claimed. */
export interface LocalTaskDeliveryContext {
  taskId: number;
  taskTitle: string;
  taskDescription: string;
  taskType: string;
  taskBranchName: string;
  /** Existing PR URL for this task, if any (rework pass). */
  pullRequestUrl: string | null;
}

/**
 * Path to write/read the JSON delivery result for a given session, mirroring
 * worker.js's `DELIVERY_RESULT_PATH` (`/tmp/kirofactory-delivery-result-<id>.json`).
 * Uses `os.tmpdir()` instead of a hardcoded `/tmp` so this also works on
 * Windows, where local sessions actually run.
 */
export function buildDeliveryResultPath(sessionId: number): string {
  return resolve(tmpdir(), `kirofactory-delivery-result-${sessionId}.json`);
}

/** Mirrors worker.js's per-session REVIEW_MARKER_PATH (see its own comment there). */
function buildReviewMarkerPath(sessionId: number): string {
  return resolve(tmpdir(), `kirofactory-review-comments-${sessionId}.count`);
}

function envList(entries: Array<[string, string | undefined | false]>): Array<{ name: string; value: string }> {
  return entries
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .map(([name, value]) => ({ name, value }));
}

/**
 * Build the `git-delivery` MCP server entry for a claimed task. Gives the
 * editor-kind agent `sync_task_branch`/`finalize_branch_sync`/
 * `submit_task_changes` tools to drive commit/push/PR itself, exactly as
 * the ACA path does. Returns null if no repository is configured for the
 * session (nothing to deliver to).
 */
export function buildLocalGitDeliveryServer(
  workspace: string,
  git: LocalGitDeliveryContext,
  task: LocalTaskDeliveryContext,
  deliveryResultPath: string
): McpServerEntry | null {
  if (!git.repositoryUrl) return null;

  return {
    name: "git-delivery",
    command: "node",
    args: [resolve(WORKER_DIR, "git-delivery-mcp-server.js")],
    env: envList([
      ["WORKSPACE", workspace],
      ["TASK_BRANCH_NAME", task.taskBranchName],
      ["DEV_BRANCH", git.devBranch],
      ["TASK_ID", String(task.taskId)],
      ["TASK_TITLE", task.taskTitle],
      ["TASK_DESCRIPTION", task.taskDescription],
      ["TASK_TYPE", task.taskType],
      ["TASK_PR_URL", task.pullRequestUrl || ""],
      ["REPO_URL", git.repositoryUrl],
      ["GIT_PROVIDER", git.gitProvider || ""],
      ["DELIVERY_RESULT_PATH", deliveryResultPath],
      ["GITHUB_PAT", git.githubPat],
      ["AZURE_DEVOPS_PAT", git.azureDevOpsPat],
    ]),
  };
}

/**
 * Build the `pr-review` MCP server entry for a claimed task. Gives the
 * agent `get_pr_review_comments`/`resolve_review_comment` tools (editor-kind:
 * read + resolve only) or `post_review_comment` (inspector-kind, handled
 * separately by the existing session-level MCP wiring for review agents —
 * this builder is only used from the developer-agent's editor-kind path).
 *
 * Returns null if no repository is configured for the session.
 */
export function buildLocalPrReviewServer(
  sessionId: number,
  git: LocalGitDeliveryContext,
  task: LocalTaskDeliveryContext,
  agentKind: "editor" | "inspector"
): McpServerEntry | null {
  if (!git.repositoryUrl) return null;

  return {
    name: "pr-review",
    command: "node",
    args: [resolve(WORKER_DIR, "pr-review-mcp-server.js")],
    env: envList([
      ["REPO_URL", git.repositoryUrl],
      ["GIT_PROVIDER", git.gitProvider || ""],
      ["DEV_BRANCH", git.devBranch],
      ["REVIEW_MARKER_PATH", buildReviewMarkerPath(sessionId)],
      ["ALLOW_POST_COMMENT", agentKind === "inspector" ? "true" : "false"],
      ["ALLOW_RESOLVE_COMMENT", agentKind === "inspector" ? "false" : "true"],
      ["GITHUB_PAT", git.githubPat],
      ["AZURE_DEVOPS_PAT", git.azureDevOpsPat],
      ["TASK_PR_URL", task.pullRequestUrl || ""],
    ]),
  };
}

/** Shape written by git-delivery-mcp-server.js's writeDeliveryResult(). */
export interface DeliveryResult {
  committed?: boolean;
  pushed?: boolean;
  branchName?: string;
  prUrl?: string | null;
  prCreated?: boolean;
  error?: string;
  message?: string;
}

/**
 * Git Workspace Manager — Clone, pull, branch, commit, push operations
 *
 * Handles local repository management for the developer worker:
 * - Preparing a workspace (clone or pull develop)
 * - Creating feature branches
 * - Committing and pushing changes
 *
 * All git operations use the GitHub PAT for HTTPS authentication.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { buildAuthenticatedUrl, buildBranchName } from "./repo-url-parser.js";
import type { RepoInfo } from "./repo-url-parser.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || "./workspaces";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GitExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a git command in the given working directory.
 */
async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<GitExecResult> {
  const mergedEnv = { ...process.env, ...env };
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    env: mergedEnv,
    timeout: 120_000, // 2 min timeout for git operations
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the absolute path for a repository workspace directory.
 */
export function getWorkspacePath(repoInfo: RepoInfo): string {
  return resolve(WORKSPACE_ROOT, repoInfo.workspaceDirName);
}

/**
 * Prepare the workspace: clone if missing, or fetch + checkout develop + pull.
 * Ensures the workspace is clean and up-to-date with origin/develop.
 *
 * @returns The absolute path to the workspace directory.
 * @throws If develop branch doesn't exist or git operations fail.
 */
export async function prepareWorkspace(
  repoInfo: RepoInfo,
  pat: string
): Promise<string> {
  const workspacePath = getWorkspacePath(repoInfo);
  const authUrl = buildAuthenticatedUrl(repoInfo.owner, repoInfo.repo, pat);

  // Ensure workspace root exists
  await mkdir(resolve(WORKSPACE_ROOT), { recursive: true });

  if (existsSync(join(workspacePath, ".git"))) {
    // Existing checkout — update it
    // Set the remote URL to the authenticated one (in case PAT changed)
    await git(["remote", "set-url", "origin", authUrl], workspacePath);

    // Fetch latest
    await git(["fetch", "origin"], workspacePath);

    // Abort any in-progress operations
    try {
      await git(["merge", "--abort"], workspacePath);
    } catch { /* no merge in progress */ }
    try {
      await git(["rebase", "--abort"], workspacePath);
    } catch { /* no rebase in progress */ }

    // Checkout develop
    try {
      await git(["checkout", "develop"], workspacePath);
    } catch {
      // Maybe develop doesn't exist locally yet but exists on remote
      try {
        await git(["checkout", "-b", "develop", "origin/develop"], workspacePath);
      } catch {
        throw new Error(
          `Branch 'develop' does not exist on remote for ${repoInfo.owner}/${repoInfo.repo}`
        );
      }
    }

    // Reset to remote state (discard any local changes from previous runs)
    await git(["reset", "--hard", "origin/develop"], workspacePath);

    // Clean untracked files
    await git(["clean", "-fd"], workspacePath);
  } else {
    // Fresh clone
    await mkdir(workspacePath, { recursive: true });
    await execFileAsync("git", ["clone", authUrl, workspacePath], {
      encoding: "utf-8",
      timeout: 300_000, // 5 min for clone
    });

    // Verify develop branch exists
    try {
      await git(["checkout", "develop"], workspacePath);
    } catch {
      // Try to create it tracking remote
      try {
        await git(["checkout", "-b", "develop", "origin/develop"], workspacePath);
      } catch {
        throw new Error(
          `Branch 'develop' does not exist on remote for ${repoInfo.owner}/${repoInfo.repo}`
        );
      }
    }
  }

  return workspacePath;
}

/**
 * Create a new feature branch from develop.
 *
 * @returns The branch name that was created.
 */
export async function createFeatureBranch(
  workspacePath: string,
  taskType: string,
  taskId: number,
  taskTitle: string
): Promise<string> {
  const branchName = buildBranchName(taskType, taskId, taskTitle);

  // Delete the branch locally if it already exists (from a previous failed run)
  try {
    await git(["branch", "-D", branchName], workspacePath);
  } catch { /* branch doesn't exist, that's fine */ }

  // Create and checkout the new branch
  await git(["checkout", "-b", branchName], workspacePath);

  return branchName;
}

/**
 * Commit all changes in the workspace.
 *
 * @returns true if a commit was created, false if there were no changes.
 */
export async function commitChanges(
  workspacePath: string,
  taskId: number,
  taskTitle: string,
  taskType: string,
  taskPriority: number,
  taskDescription: string
): Promise<boolean> {
  // Check for changes
  const { stdout: status } = await git(["status", "--porcelain"], workspacePath);
  if (!status || status.trim().length === 0) {
    return false;
  }

  // Stage all changes
  await git(["add", "-A"], workspacePath);

  // Build commit message
  const commitTitle = `${taskTitle} [Vibecode Heaven #${taskId}]`;
  const commitBody = [
    "",
    `Task: ${taskTitle}`,
    `ID: ${taskId}`,
    `Type: ${taskType}`,
    `Priority: ${taskPriority}`,
    "",
    taskDescription || "(no description)",
  ].join("\n");

  await git(["commit", "-m", commitTitle + "\n" + commitBody], workspacePath);

  return true;
}

/**
 * Push the current branch to origin with retry logic.
 *
 * @param maxAttempts Maximum push attempts (default: 2)
 * @param delayMs Delay between retries in milliseconds (default: 2000)
 * @throws If push fails after all attempts.
 */
export async function pushBranch(
  workspacePath: string,
  branchName: string,
  maxAttempts = 2,
  delayMs = 2000
): Promise<void> {
  let lastError: string = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await git(["push", "-u", "origin", branchName], workspacePath);
      return; // Success
    } catch (err: any) {
      lastError = err.stderr || err.message || String(err);
      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }

  throw new Error(`Push failed after ${maxAttempts} attempts: ${lastError}`);
}

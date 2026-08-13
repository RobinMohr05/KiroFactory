/**
 * Git Workspace Manager — Clone, pull, branch, commit, push operations
 *
 * Handles local repository management for the developer worker:
 * - Preparing a workspace (clone or pull from develop/dev/main)
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
 * Ensures the workspace is clean and up-to-date with the development branch.
 *
 * Tries branches in order: develop → dev → main.
 *
 * @returns An object with the workspace path and the resolved base branch name.
 * @throws If none of the candidate branches exist or git operations fail.
 */
export async function prepareWorkspace(
  repoInfo: RepoInfo,
  pat: string
): Promise<{ workspacePath: string; baseBranch: string }> {
  const workspacePath = getWorkspacePath(repoInfo);
  const authUrl = buildAuthenticatedUrl(repoInfo.owner, repoInfo.repo, pat);
  const candidateBranches = ["develop", "dev", "main"];

  // Ensure workspace root exists
  await mkdir(resolve(WORKSPACE_ROOT), { recursive: true });

  let resolvedBranch: string;

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

    // Try each candidate branch in order
    let checkedOutBranch: string | null = null;
    for (const branch of candidateBranches) {
      try {
        await git(["checkout", branch], workspacePath);
        checkedOutBranch = branch;
        break;
      } catch {
        // Maybe branch doesn't exist locally yet but exists on remote
        try {
          await git(["checkout", "-b", branch, `origin/${branch}`], workspacePath);
          checkedOutBranch = branch;
          break;
        } catch {
          // Branch doesn't exist, try next candidate
        }
      }
    }

    if (!checkedOutBranch) {
      throw new Error(
        `None of the branches [${candidateBranches.join(", ")}] exist on remote for ${repoInfo.owner}/${repoInfo.repo}`
      );
    }

    resolvedBranch = checkedOutBranch;

    // Reset to remote state (discard any local changes from previous runs)
    await git(["reset", "--hard", `origin/${resolvedBranch}`], workspacePath);

    // Clean untracked files
    await git(["clean", "-fd"], workspacePath);
  } else {
    // Fresh clone — try each candidate branch
    await mkdir(workspacePath, { recursive: true });

    let clonedBranch: string | null = null;
    for (const branch of candidateBranches) {
      try {
        await execFileAsync("git", ["clone", "--branch", branch, authUrl, workspacePath], {
          encoding: "utf-8",
          timeout: 300_000, // 5 min for clone
        });
        clonedBranch = branch;
        break;
      } catch {
        // Branch doesn't exist on remote, try next
        // Clean up failed clone attempt
        try {
          await execFileAsync("rm", ["-rf", workspacePath], { encoding: "utf-8" });
          await mkdir(workspacePath, { recursive: true });
        } catch { /* ignore cleanup errors */ }
      }
    }

    if (!clonedBranch) {
      throw new Error(
        `None of the branches [${candidateBranches.join(", ")}] exist on remote for ${repoInfo.owner}/${repoInfo.repo}`
      );
    }

    resolvedBranch = clonedBranch;
  }

  return { workspacePath, baseBranch: resolvedBranch };
}

/**
 * Install the workspace's dependencies so the agent can actually build and
 * run tests (e.g. `npm test`, `npm run build`).
 *
 * Uses `npm ci` when a lockfile is present (deterministic, matches CI),
 * otherwise `npm install`. Passes `--include=dev` explicitly: this installs a
 * cloned TARGET repo's dependencies in a long-lived dev-agent process, and if
 * NODE_ENV happens to be "production" (or npm's `omit` config is set) in this
 * process's environment, npm's `omit` option defaults to 'dev' — every
 * devDependency (test runner, compiler, type stubs) then resolves into
 * package-lock.json but is never actually written to node_modules, even
 * though the install exits 0. That exact silent-skip bug is what broke
 * vitest/typescript in the ACA worker container (fixed by removing
 * `NODE_ENV=production` from worker/Dockerfile) — this flag makes the
 * workspace immune to the same class of bug regardless of environment.
 *
 * Best-effort by design: callers should log a warning and continue on
 * failure rather than fail the whole task, since some tasks (e.g. doc-only
 * changes) don't need a successful install.
 */
export async function installDependencies(workspacePath: string): Promise<void> {
  if (!existsSync(join(workspacePath, "package.json"))) return;

  const hasLockfile = existsSync(join(workspacePath, "package-lock.json"));
  const args = hasLockfile ? ["ci", "--include=dev"] : ["install", "--include=dev"];

  // npm ships as npm.cmd on Windows — child_process.execFile (no shell) can't
  // launch .cmd files directly and fails with ENOENT unless the .cmd suffix
  // is given explicitly.
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

  await execFileAsync(npmBin, args, {
    cwd: workspacePath,
    encoding: "utf-8",
    timeout: 300_000, // 5 min — large monorepos can be slow to install
  });
}

/**
 * Checkout an existing remote branch (for shared/grouped task workflows).
 *
 * Fetches from origin, then checks out the branch. If the branch exists
 * locally, it resets to match the remote. If it only exists on the remote,
 * it creates a local tracking branch.
 *
 * @returns The branch name that was checked out.
 * @throws If the branch does not exist on the remote.
 */
export async function checkoutExistingBranch(
  workspacePath: string,
  branchName: string
): Promise<string> {
  // Fetch latest from origin to ensure we have the remote branch
  await git(["fetch", "origin"], workspacePath);

  // Verify the branch exists on remote before attempting checkout
  try {
    await git(["rev-parse", "--verify", `origin/${branchName}`], workspacePath);
  } catch {
    throw new Error(
      `Branch "${branchName}" does not exist on remote.`
    );
  }

  // Try checking out the branch locally
  try {
    await git(["checkout", branchName], workspacePath);
    // Reset to match remote (pick up any new commits from sibling tasks)
    await git(["reset", "--hard", `origin/${branchName}`], workspacePath);
  } catch {
    // Branch doesn't exist locally — create from remote tracking branch
    await git(["checkout", "-b", branchName, `origin/${branchName}`], workspacePath);
  }

  return branchName;
}

/**
 * Create a new feature branch from the current base branch.
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

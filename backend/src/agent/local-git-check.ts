/**
 * Local Git State Check — Detects whether any file changes exist in the
 * working tree at a given path.
 *
 * Used by runLoopMode() to gate editor-kind agent success: a turn that
 * produces no observable file changes (uncommitted or committed ahead of
 * the base branch) should not be trusted as a successful implementation.
 *
 * This is the local-mode equivalent of the `hasChanges`/`committed`
 * cross-check that runLoopModeAca() gets from the ACA worker.
 */

import { execSync } from "node:child_process";

/**
 * Returns true if the working directory at `cwd` has any git changes
 * (staged, unstaged, or untracked files) OR has commits ahead of the
 * default branch (develop/main).
 *
 * Returns false if:
 * - No changes and no new commits exist
 * - The directory is not a git repository (fails gracefully)
 * - The git command fails for any reason (fails gracefully → no changes assumed)
 */
export function hasLocalGitChanges(cwd: string): boolean {
  try {
    // Check for any working tree changes (staged, unstaged, untracked)
    const status = execSync("git status --porcelain", {
      cwd,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (status.length > 0) {
      return true;
    }

    // No working tree changes — check if there are commits ahead of the
    // base branch (the agent may have committed but changes are clean now)
    // Try develop first, fall back to main
    for (const base of ["origin/develop", "origin/main", "develop", "main"]) {
      try {
        const log = execSync(`git log ${base}..HEAD --oneline`, {
          cwd,
          encoding: "utf-8",
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        if (log.length > 0) {
          return true;
        }
        // Successfully ran against this base — use this result
        return false;
      } catch {
        // This base branch doesn't exist — try next
        continue;
      }
    }

    // Could not determine base branch — fall through to false
    return false;
  } catch {
    // git command failed entirely (not a repo, git not installed, etc.)
    // Fail safe: assume no changes (don't block on a broken git setup)
    return false;
  }
}

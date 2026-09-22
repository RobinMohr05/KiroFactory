/**
 * Workspace Utilities
 *
 * Filesystem helpers for the worker's clone workspace.
 *
 * Plain JS module (no TypeScript) — the worker container runs Node directly
 * without a compilation step.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Empty a directory's contents WITHOUT removing the directory itself.
 *
 * The worker image runs as the unprivileged `node` user (UID 1000, task
 * #1985). The clone-retry loop in setupRepo() must reset the workspace
 * between branch attempts, but it cannot `rm -rf /workspace` the way the
 * old root image did: deleting the /workspace directory itself means the
 * next `git clone <url> /workspace` has to recreate a direct child of
 * root-owned `/` (mode 755), which fails with EACCES for a non-root user.
 * The confusing permission error would then mask the real "branch not
 * found" condition the loop is trying to detect.
 *
 * This removes every entry inside `dir` (including dotfiles) while leaving
 * the node-owned `dir` in place so subsequent clone attempts can reuse it.
 * A missing directory is treated as already-clear (no-op).
 */
export function clearWorkspaceContents(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

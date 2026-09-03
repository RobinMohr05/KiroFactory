/**
 * Branch name helpers shared by the agent pipeline.
 *
 * Historically this file also parsed GitHub repo URLs and built authenticated
 * clone URLs / task-branch names for the standalone `dev-agent.ts` workflow.
 * That workflow was removed (dead code — never invoked by any Dockerfile, the
 * ACA worker, or session-manager.ts; the ACA worker has its own independent
 * git implementation in `worker/worker.js`). Only the persistent-branch-name
 * helper used by production loop sessions (`session-manager.ts`) remains.
 */

/**
 * Slugify a title for use in a branch name.
 *
 * Rules:
 * - Lowercase
 * - Spaces replaced with hyphens
 * - Strip characters not in [a-z0-9-]
 * - Collapse multiple hyphens into one
 * - Truncate to max 60 characters
 * - Trim trailing hyphens
 */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60)
    .replace(/-+$/, "");
}

/**
 * Build a persistent branch name for a standalone (no-task) session.
 *
 * Format: [session_name_slug]-s[session_id]
 * Example: my-research-session-s42
 *
 * The session ID suffix guarantees uniqueness even when multiple sessions
 * share the same name.
 */
export function buildPersistentBranchName(
  sessionId: number,
  sessionName: string
): string {
  const slug = slugifyTitle(sessionName);
  if (slug) {
    return `${slug}-s${sessionId}`;
  }
  return `s${sessionId}`;
}

/**
 * Build a deterministic per-task branch name: [type]/#[id]_[slug]
 * Example: bug/#598_local-mode-pipeline-has-no-commit-gate
 *
 * Mirrors `worker/worker.js`'s `buildBranchName()` exactly — the ACA path's
 * git-delivery MCP server (`TASK_BRANCH_NAME`) and this local counterpart
 * must compute the identical name for the same task, since either path may
 * pick up a task another path previously started (task.branch persisted in
 * the DB is otherwise the only source of truth once a branch already
 * exists remotely).
 */
export function buildTaskBranchName(
  taskType: string,
  taskId: number,
  taskTitle: string
): string {
  return `${taskType}/#${taskId}_${slugifyTitle(taskTitle)}`;
}

/**
 * Sanitize a branch name before it is persisted to `t.branch` or used to
 * build a shell/env value.
 *
 * `t.branch` is treated as ground truth once written — every AC1/AC2 sibling
 * lookup and the ACA worker's `TASK_BRANCH_NAME` env var copy it verbatim,
 * with no sanitization anywhere downstream. A single malformed write (e.g.
 * stray leading/trailing whitespace or an embedded newline, however it got
 * there) becomes permanent and propagates to every sibling task and to the
 * git-delivery MCP server's `git checkout -B <name>` call, which fails with
 * an invalid-ref error. Call this at every write site (`setTaskBranchAndPr`,
 * `resolveTask`, `resetTask`) so no caller can persist a value one raw
 * `.trim()` wouldn't have caught — regardless of what originally produced it.
 *
 * Returns `null` (never persist / never fall back to a raw value) if the
 * input is empty after trimming, since git does not allow an empty ref name.
 */
export function sanitizeBranchName(branch: string | null | undefined): string | null {
  if (branch == null) return null;
  // Collapse any internal whitespace/control characters (newlines, tabs,
  // carriage returns) that could break a `git checkout -B <name>` invocation
  // or make an env var value invalid, then trim the ends.
  const cleaned = branch.replace(/[\r\n\t]+/g, "").trim();
  return cleaned || null;
}

/**
 * Shared Branch Utilities
 *
 * Pure logic functions for the shared branch/PR feature (task #163).
 * Used by worker.js for PR content generation and sibling branch lookup.
 *
 * Plain JS module (no TypeScript) — the worker container runs Node directly
 * without a compilation step.
 */

/**
 * Build PR title and body that references all tasks in a shared-branch group.
 *
 * When there are no siblings, behaves like the original single-task PR content.
 * When there are siblings, the title lists all task IDs and the body includes
 * a table of all tasks.
 *
 * @param {object} currentTask The task currently being worked on
 * @param {Array<object>} siblings Other tasks sharing the same branch (may be empty)
 * @returns {{ title: string, body: string }}
 */
export function buildGroupPrContent(currentTask, siblings) {
  const allTasks = [...siblings, currentTask].sort((a, b) => a.id - b.id);

  if (allTasks.length === 1) {
    // Single task — match the existing format from worker.js buildPrContent()
    const task = allTasks[0];
    return {
      title: `${task.title} [KiroFactory #${task.id}]`,
      body: [
        "## Task",
        "",
        `**Title:** ${task.title}`,
        `**Type:** ${task.type}`,
        `**ID:** ${task.id}`,
        "",
        "## Description",
        "",
        task.description || "_(no description provided)_",
        "",
        "---",
        "*Created automatically by KiroFactory*",
      ].join("\n"),
    };
  }

  // Multiple tasks — group PR format
  const taskIds = allTasks.map((t) => `#${t.id}`).join(", ");
  const title = `[KiroFactory ${taskIds}] Grouped tasks`;

  const taskRows = allTasks
    .map((t) => `| ${t.id} | ${t.type} | ${t.title} |`)
    .join("\n");

  const descriptions = allTasks
    .map((t) => [
      `### #${t.id} — ${t.title}`,
      "",
      `**Type:** ${t.type}`,
      "",
      t.description || "_(no description provided)_",
    ].join("\n"))
    .join("\n\n");

  const body = [
    "## Grouped Tasks",
    "",
    "| ID | Type | Title |",
    "|---|---|---|",
    taskRows,
    "",
    "## Descriptions",
    "",
    descriptions,
    "",
    "---",
    "*Created automatically by KiroFactory*",
  ].join("\n");

  return { title, body };
}

/**
 * Find the PR URL from sibling tasks in a shared-branch group.
 *
 * When the current task's own `pullRequestUrl` is null (because only the
 * first task that created the PR has it persisted), this function finds
 * the PR URL from any sibling that has one.
 *
 * @param {Array<{pullRequestUrl: string|null}>} siblings
 * @returns {string | null} The PR URL, or null if no sibling has one
 */
export function findSiblingPrUrl(siblings) {
  const withPr = siblings.find((s) => s.pullRequestUrl);
  return withPr ? withPr.pullRequestUrl : null;
}

/**
 * Find the shared branch (and PR URL) from a set of sibling tasks.
 *
 * Returns the branch info from the first sibling that has a branch set,
 * preferring one that also has a pullRequestUrl.
 *
 * NOTE: Currently unused in production — sibling lookup is handled server-side
 * by `findSiblingTasks()` in `task-claimer.ts`, and the worker receives sibling
 * data pre-resolved via `currentTaskMeta.siblingTasks`. Kept as a tested utility
 * for potential future use in a worker-side discovery path (e.g., if the worker
 * ever needs to query siblings independently when the orchestrator can't
 * pre-resolve them).
 *
 * @param {Array<{branch: string|null, pullRequestUrl: string|null}>} siblings
 * @returns {{ branch: string, pullRequestUrl: string|null } | null}
 */
export function findGroupBranchFromSiblings(siblings) {
  // First try to find a sibling with both branch and PR URL
  const withPr = siblings.find((s) => s.branch && s.pullRequestUrl);
  if (withPr && withPr.branch) {
    return { branch: withPr.branch, pullRequestUrl: withPr.pullRequestUrl };
  }

  // Fall back to any sibling with a branch
  const withBranch = siblings.find((s) => s.branch);
  if (withBranch && withBranch.branch) {
    return { branch: withBranch.branch, pullRequestUrl: withBranch.pullRequestUrl };
  }

  return null;
}

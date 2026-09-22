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
 * Neutralize Azure Repos' work-item auto-link syntax ("#<digits>") inside
 * free-form text (task titles, descriptions) before it's embedded into a
 * commit message or PR title/body.
 *
 * This repo (and every KiroFactory/tecfactory deployment on Azure Repos Git)
 * is subject to Azure Boards' native work-item linker: any bare "#<number>"
 * found in a commit message or PR title/description auto-links to whatever
 * work item has that numeric ID *anywhere in the Azure DevOps organization*
 * — with zero awareness that the number is actually a KiroFactory task ID,
 * a GitHub-style issue reference the user typed, or anything else. See
 * knowledge-base/knowledge/azure-boards-accidental-worklink.md for the
 * incident this fixes (work item #1774 in an unrelated project got linked
 * because a PR title contained "#1774").
 *
 * The task-ID suffix sites (`[KiroFactory KF-<id>]` etc.) were already
 * changed to not use a bare "#" at all. This function is the second half of
 * that fix: it defends free-form, user/agent-authored text — task titles
 * and descriptions — which can independently contain a "#<digits>" sequence
 * (e.g. a title that mentions "fixes #42" or a description pasted from
 * somewhere else) and would otherwise carry the same hazard straight into
 * the PR body even after the suffix itself was fixed.
 *
 * Inserts a zero-width non-joiner (U+200C) between "#" and the digits. This
 * is invisible in rendered Markdown/plain text (GitHub, Azure DevOps, and
 * every mainstream renderer skip it silently) but breaks the "#<digits>"
 * pattern both GitHub's issue-autolinker and Azure Repos' work-item linker
 * scan for, so the reference can never resolve to a real issue/work item.
 *
 * @param {string} text
 * @returns {string}
 */
export function neutralizeIssueLinks(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(/#(\d+)/g, "#\u200C$1");
}

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
      // "KF-<id>", not "#<id>" — this repo is hosted on Azure Repos Git,
      // where Azure Boards auto-links a bare "#<number>" in a PR
      // title/description to any work item sharing that numeric ID
      // anywhere in the Azure DevOps organization — unrelated to
      // KiroFactory's own task numbering. "KF-<id>" is not Azure Boards
      // link syntax (that's "AB#<id>"), so it can't trigger the auto-link.
      title: `${neutralizeIssueLinks(task.title)} [KiroFactory KF-${task.id}]`,
      body: [
        "## Task",
        "",
        `**Title:** ${neutralizeIssueLinks(task.title)}`,
        `**Type:** ${task.type}`,
        `**ID:** ${task.id}`,
        "",
        "## Description",
        "",
        neutralizeIssueLinks(task.description) || "_(no description provided)_",
        "",
        "---",
        "*Created automatically by KiroFactory*",
      ].join("\n"),
    };
  }

  // Multiple tasks — group PR format.
  // "KF-<id>", not "#<id>" — see the comment on the single-task title above;
  // same Azure Boards auto-link hazard applies here.
  const taskIds = allTasks.map((t) => `KF-${t.id}`).join(", ");
  const title = `[KiroFactory ${taskIds}] Grouped tasks`;

  const taskRows = allTasks
    .map((t) => `| ${t.id} | ${t.type} | ${neutralizeIssueLinks(t.title)} |`)
    .join("\n");

  const descriptions = allTasks
    .map((t) => [
      `### KF-${t.id} — ${neutralizeIssueLinks(t.title)}`,
      "",
      `**Type:** ${t.type}`,
      "",
      neutralizeIssueLinks(t.description) || "_(no description provided)_",
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


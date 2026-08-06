/**
 * Prompt Builder — Constructs focused prompts for the developer agent
 *
 * Takes a claimed task and builds a prompt that instructs the Kiro agent
 * on exactly what to implement, with clear boundaries and exit criteria.
 */

import type { ClaimedTask } from "./task-claimer.js";

/**
 * Build the main developer prompt for a claimed task.
 *
 * The prompt gives the agent:
 * - The exact task to implement (no ambiguity)
 * - Relevant file context
 * - Clear success criteria
 * - Rules to prevent scope creep
 */
export function buildDevPrompt(task: ClaimedTask, cwd: string): string {
  const filesList =
    task.files.length > 0
      ? task.files.map((f) => `  - ${f}`).join("\n")
      : "  (no specific files listed — investigate based on description)";

  // If a PR already exists, this is a rework pass — surface that prominently.
  const reworkSection = task.pullRequestUrl
    ? `
## REWORK PASS — PR REVIEW COMMENTS

This task already has an open pull request: **${task.pullRequestUrl}**
You are resuming work on branch \`${task.branch || "see git status"}\` to address reviewer feedback.

**FIRST ACTION:** Call the \`get_pr_review_comments\` tool to fetch all open review comments on the PR.
Address every comment — treat each one as a required fix. Do NOT skip any.
Once all comments are addressed, the implementation will be re-reviewed.
`
    : "";

  return `You are the Developer Implementation Agent. You have been ASSIGNED a specific task.
Do NOT pick a task yourself — this task has already been selected and claimed for you.
${reworkSection}
## YOUR ASSIGNED TASK

**Task ID:** ${task.id}
**Title:** ${task.title}
**Priority:** ${task.priority} (${getPriorityLabel(task.priority)})
**Type:** ${task.type}
**Description:** ${task.description || "(no description provided)"}
${task.branch ? `**Branch:** \`${task.branch}\`` : ""}
${task.pullRequestUrl ? `**Pull Request:** ${task.pullRequestUrl}` : ""}

**Relevant files:**
${filesList}

## INSTRUCTIONS

${task.pullRequestUrl
  ? "1. Call `get_pr_review_comments` first to fetch all open PR review comments. Address every comment before doing anything else.\n2. After fixing all comments, verify your changes compile correctly (run `npm run build` if applicable)."
  : "1. Read the relevant source files to understand the current state of the code.\n2. Implement the change described above. Follow the existing code style and conventions.\n3. After implementing, verify your changes compile correctly (run `npm run build` if applicable)."}
${task.pullRequestUrl ? "3." : "4."} STOP after completing this single task. Do not pick another task.

## CRITICAL RULES

- Do NOT look for other tasks. Your task is assigned above.
- Keep changes minimal and focused on THIS task only.
- If the work described is ALREADY implemented in the codebase, note that it's already done and exit.
- If the task cannot be completed (missing dependencies, unclear requirements), explain why and exit.
- Do NOT introduce unrelated refactoring or improvements beyond what the task requires.
- Do NOT modify test files unless the task specifically asks for test changes.
- Do NOT run git commit, git push, or create pull requests. The orchestrator handles git operations automatically after your work is complete.
- Do NOT run any git commands at all (no git add, commit, push, branch, checkout, pull request). The orchestrator manages ALL git operations.
- Do NOT create or switch branches. You are already on the correct branch.

## WORKING DIRECTORY

${cwd}

This is the checked-out repository where your task should be implemented. All file paths are relative to this directory.
`;
}

/**
 * Build a TDD-oriented developer prompt for a claimed task.
 *
 * Instructs the agent to follow Red-Green-Refactor:
 * 1. Write failing tests first
 * 2. Implement minimal code to pass
 * 3. Refactor while keeping tests green
 */
export function buildTddDevPrompt(task: ClaimedTask, cwd: string): string {
  const filesList =
    task.files.length > 0
      ? task.files.map((f) => `  - ${f}`).join("\n")
      : "  (no specific files listed — investigate based on description)";

  return `You are the TDD Developer Agent. Follow RED-GREEN-REFACTOR strictly.

## YOUR ASSIGNED TASK

**Task ID:** ${task.id}
**Title:** ${task.title}
**Priority:** ${task.priority} (${getPriorityLabel(task.priority)})
**Type:** ${task.type}
**Description:** ${task.description || "(no description provided)"}

**Relevant files:**
${filesList}

## TDD WORKFLOW (follow this exact order)

### Step 0 — Check for PR review comments (rework pass)
- If this task already has an associated pull request (you are resuming on an existing branch, not starting fresh), call the \`get_pr_review_comments\` tool first.
- Treat every comment it returns as a required fix — write a failing test for each one where applicable, then implement the fix, following the same RED-GREEN-REFACTOR flow as any other requirement.
- Address ALL review comments before considering the task complete.

### Step 1 — Write tests FIRST
- Identify or create the test file for the module being changed (colocated: \`foo.test.ts\` next to \`foo.ts\`).
- Write test cases that describe the expected behavior from the task description.
- Use Vitest: \`import { describe, it, expect } from 'vitest'\`.
- Tests MUST initially FAIL because the implementation doesn't exist yet.

### Step 2 — Verify RED
- Run: \`npx vitest run --reporter=verbose <test-file>\`
- Confirm tests fail. If they already pass, the feature is already implemented — report that and stop.

### Step 3 — Implement (minimal)
- Write the minimum code to make all tests pass.
- Follow existing code style and conventions.
- Do NOT add features beyond what the tests require.

### Step 4 — Verify GREEN
- Run: \`npx vitest run --reporter=verbose <test-file>\`
- ALL tests must pass. If any fail, fix the implementation (not the tests).

### Step 5 — Refactor (optional)
- Clean up while keeping tests green.
- Run tests again after any refactor.

### Step 6 — Full build check
- Run: \`npm run build\`
- Ensure no type errors.

## CRITICAL RULES

- Do NOT skip writing tests first. This is the entire point.
- Do NOT weaken or delete tests to make them pass.
- Keep changes minimal and focused on THIS task only.
- If the task is ALREADY implemented (tests pass immediately), note that and exit.
- If the task cannot be completed, explain why and exit.
- Do NOT modify unrelated code or introduce scope creep.
- Do NOT run any git commands (no git add, commit, push, branch, checkout, pull request). The orchestrator manages ALL git operations.
- Do NOT create or switch branches. You are already on the correct branch.
- STOP after completing this single task.

## WORKING DIRECTORY

${cwd}

This is the checked-out repository where your task should be implemented. All file paths are relative to this directory.
`;
}

/**
 * Build the per-turn prompt for inspector-kind agents (e.g. code-reviewer-agent,
 * qa-improvement-agent).
 *
 * Unlike `buildDevPrompt`, this does NOT instruct the agent to implement or
 * change anything — inspector agents only read the diff, post PR comments,
 * and report a verdict. The domain-specific review/QA criteria live in the
 * agent's own DB-configured system prompt; this turn prompt just supplies the
 * task/PR context and the hard rules that apply to every inspector agent
 * regardless of what it's specifically looking for.
 *
 * Bug this fixes: previously every loop-mode session sent `buildDevPrompt`
 * (the "implement this" prompt) as the turn prompt no matter which agent was
 * configured, so inspector agents were told to implement the very feature
 * they were supposed to be reviewing — contradicting their own system prompt.
 */
export function buildReviewPrompt(task: ClaimedTask, cwd: string): string {
  const filesList =
    task.files.length > 0
      ? task.files.map((f) => `  - ${f}`).join("\n")
      : "  (no specific files listed — investigate based on the diff)";

  return `You have been ASSIGNED a task to inspect. Follow the review/QA workflow and criteria described in your system prompt.

## TASK BEING REVIEWED

**Task ID:** ${task.id}
**Title:** ${task.title}
**Priority:** ${task.priority} (${getPriorityLabel(task.priority)})
**Type:** ${task.type}
**Description:** ${task.description || "(no description provided)"}
**Branch:** ${task.branch || "(unknown — run git status/git branch to confirm)"}
**Pull Request:** ${task.pullRequestUrl || "(no PR URL provided — check git remote or your PR tooling if needed)"}

**Files likely touched:**
${filesList}

## INSTRUCTIONS

1. Identify what changed for this task (e.g. \`git diff origin/develop...HEAD\` or the appropriate base branch — fall back to \`git log --oneline -1\` / \`git diff HEAD~1\` if that fails).
2. Review the diff following the workflow and criteria described in your system prompt.
3. For every issue found, call \`post_review_comment\` exactly once per issue. This is the ONLY place your findings are recorded — if you don't call it, your findings exist nowhere the next agent can see them.
4. Call \`report_verdict\` exactly once when finished: \`"no_action_needed"\` if you found zero issues, \`"changes_requested"\` if you posted one or more comments.

## CRITICAL RULES

- Do NOT edit, create, or delete any file in the repository.
- Do NOT run \`npm run build\`, tests, installs, or any command that changes the working tree.
- Do NOT run any git command that changes repository state (commit, push, branch, checkout). Read-only git commands (diff, log, status, show) are fine.
- Do NOT pick another task. Only inspect the task assigned above.
- Never describe an issue only in your own response text and skip \`post_review_comment\` — a finding that isn't posted as a PR comment is invisible to everyone else and accomplishes nothing.
- \`report_verdict\` will REJECT verdict \`"changes_requested"\` if you have not called \`post_review_comment\` at least once this turn. If you get this error, go back and post a comment for every issue first, then call \`report_verdict\` again.
- You MUST call \`report_verdict\` exactly once before finishing.
- STOP once you've reported your verdict.

## WORKING DIRECTORY

${cwd}

This is the checked-out repository, already on the correct branch for this task.
`;
}

/**
 * Build a verification prompt to check if the agent's work was successful.
 * This can be sent as a follow-up if needed.
 */
export function buildVerifyPrompt(task: ClaimedTask): string {
  return `Verify that the implementation for task "${task.title}" is complete and correct.

Check:
1. The described change has been implemented
2. No build errors (run \`npm run build\` if applicable)
3. The change matches the task description

If everything looks good, say "VERIFICATION_PASSED".
If there are issues, describe them briefly.`;
}

function getPriorityLabel(priority: number): string {
  switch (priority) {
    case 1: return "Critical";
    case 2: return "High";
    case 3: return "Medium";
    case 4: return "Low";
    default: return "Unknown";
  }
}

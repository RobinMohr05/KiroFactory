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

  return `You are the Developer Implementation Agent. You have been ASSIGNED a specific task.
Do NOT pick a task yourself — this task has already been selected and claimed for you.

## YOUR ASSIGNED TASK

**Task ID:** ${task.id}
**Title:** ${task.title}
**Priority:** ${task.priority} (${getPriorityLabel(task.priority)})
**Type:** ${task.type}
**Description:** ${task.description || "(no description provided)"}

**Relevant files:**
${filesList}

## INSTRUCTIONS

1. Read the relevant source files to understand the current state of the code.
2. Implement the change described above. Follow the existing code style and conventions.
3. After implementing, verify your changes compile correctly (run \`npm run build\` if applicable).
4. STOP after completing this single task. Do not pick another task.

## CRITICAL RULES

- Do NOT look for other tasks. Your task is assigned above.
- Keep changes minimal and focused on THIS task only.
- If the work described is ALREADY implemented in the codebase, note that it's already done and exit.
- If the task cannot be completed (missing dependencies, unclear requirements), explain why and exit.
- Do NOT introduce unrelated refactoring or improvements beyond what the task requires.
- Do NOT modify test files unless the task specifically asks for test changes.
- Do NOT run git commit, git push, or create pull requests. The orchestrator handles git operations automatically after your work is complete.

## WORKING DIRECTORY

${cwd}
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
- STOP after completing this single task.

## WORKING DIRECTORY

${cwd}
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

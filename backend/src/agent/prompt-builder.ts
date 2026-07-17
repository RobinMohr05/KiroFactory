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

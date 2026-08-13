/**
 * Agent module — Developer agent for autonomous task completion.
 *
 * This module provides the agent infrastructure for Vibecode Heaven:
 * - KiroRunner: Spawns kiro-cli ACP sessions and communicates via NDJSON
 * - Task Claimer: Atomic task claiming from SQL Server with row locking
 * - Prompt Builder: Constructs focused prompts from task data
 * - Dev Agent: Main entry point that ties it all together
 *
 * Usage (standalone):
 *   npx tsx src/agent/dev-agent.ts                    # claim next task
 *   npx tsx src/agent/dev-agent.ts --task 5           # claim specific task
 *   npx tsx src/agent/dev-agent.ts --loop             # continuous mode
 *   npx tsx src/agent/dev-agent.ts --agent my-agent   # custom agent
 *   npx tsx src/agent/dev-agent.ts --timeout 600      # 10 min timeout
 *
 * Usage (programmatic):
 *   import { claimTask, markTaskDeveloped } from "./agent/index.js";
 *   import { KiroRunner } from "./agent/index.js";
 */

export { KiroRunner } from "./kiro-runner.js";
export type { SessionUpdateChunk, KiroRunnerOptions, McpServerEntry } from "./kiro-runner.js";

export { claimTask, markTaskDeveloped, markTaskDone, resolveTask, resetTaskToTodo, resetTask, getAvailableTaskCount, waitForTaskAvailable, notifyTaskAvailable, getTasksByBranch } from "./task-claimer.js";
export type { ClaimedTask } from "./task-claimer.js";

export { buildDevPrompt, buildReviewPrompt, buildVerifyPrompt } from "./prompt-builder.js";

export { checkoutExistingBranch } from "./git-workspace.js";
export { findExistingPrForBranch, updatePullRequestBody, buildGroupedPrBody, buildGroupedPrTitle } from "./github-pr.js";
export { resolveBranchForTask } from "./dev-agent-helpers.js";

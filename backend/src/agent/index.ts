/**
 * Agent module — task-driven Kiro agent infrastructure used by session-manager.ts.
 *
 * - KiroRunner: Spawns kiro-cli ACP sessions and communicates via NDJSON (local worker mode)
 * - Task Claimer: Atomic task claiming from SQL Server with row locking, resolve/reset
 *   through the multi-stage pipeline (see .kiro/steering/developer-agent-task-lifecycle.md)
 * - Prompt Builder: Constructs the per-turn prompt from task data (editor vs inspector)
 *
 * There is no standalone CLI entry point in this module — production task execution
 * happens through `session-manager.ts` (local child process or ACA worker job), never
 * as an independent process run directly from this directory.
 *
 * Usage (programmatic):
 *   import { claimTask, resolveTask } from "./agent/index.js";
 *   import { KiroRunner } from "./agent/index.js";
 */

export { KiroRunner } from "./kiro-runner.js";
export type { SessionUpdateChunk, KiroRunnerOptions, McpServerEntry } from "./kiro-runner.js";

export { claimTask, markTaskDone, resolveTask, resetTask, getAvailableTaskCount, waitForTaskAvailable, notifyTaskAvailable } from "./task-claimer.js";
export type { ClaimedTask } from "./task-claimer.js";

export { buildDevPrompt, buildReviewPrompt } from "./prompt-builder.js";

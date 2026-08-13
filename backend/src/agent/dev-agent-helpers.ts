/**
 * Dev Agent Helpers — Pure helper functions for the dev-agent orchestration.
 *
 * Extracted to allow unit testing without importing the full dev-agent
 * (which has side effects like dotenv.config and process.argv parsing).
 */

export interface BranchResolutionInput {
  id: number;
  title: string;
  type: string;
  branch: string | null;
  pullRequestUrl: string | null;
}

export interface BranchResolutionResult {
  /** The resolved branch name (null if no existing branch found — caller should create new) */
  branchName: string | null;
  /** Whether the branch already exists (true = checkout, false = create new) */
  isExisting: boolean;
}

/**
 * Determine whether a task should use an existing branch or create a new one.
 *
 * Decision logic:
 * - If task.branch is set → use that existing branch
 * - Otherwise → return null (caller should create a new branch)
 *
 * Note: Looking up sibling tasks (same branch in DB) is done separately
 * at the orchestration level since it requires DB access.
 */
export function resolveBranchForTask(task: BranchResolutionInput): BranchResolutionResult {
  if (task.branch) {
    return {
      branchName: task.branch,
      isExisting: true,
    };
  }

  return {
    branchName: null,
    isExisting: false,
  };
}

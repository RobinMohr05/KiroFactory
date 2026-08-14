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
 * - If task.branch is set → use that existing branch (AC#1 / AC#2 via pre-set)
 * - If siblingBranch is provided (caller looked it up externally) → use it
 * - Otherwise → return null (caller should create a new branch)
 *
 * The dev-agent calls this WITHOUT siblingBranch — AC#2 is fulfilled by
 * pre-setting `branch` on tasks before they are claimed (via API/UI).
 * The siblingBranch parameter exists for tooling that explicitly confirms
 * group membership before assigning a branch.
 *
 * @param task The task to resolve branch for
 * @param siblingBranch Optional branch name from an explicit grouping decision (not implicit tab lookup)
 */
export function resolveBranchForTask(task: BranchResolutionInput, siblingBranch?: string | null): BranchResolutionResult {
  if (task.branch) {
    return {
      branchName: task.branch,
      isExisting: true,
    };
  }

  if (siblingBranch) {
    return {
      branchName: siblingBranch,
      isExisting: true,
    };
  }

  return {
    branchName: null,
    isExisting: false,
  };
}

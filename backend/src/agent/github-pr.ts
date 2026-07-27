/**
 * GitHub PR Creator — Creates Pull Requests via the GitHub REST API
 *
 * Uses Node's built-in fetch (Node 18+). No external dependencies.
 */

export interface CreatePrOptions {
  /** Repository owner (GitHub username or org) */
  owner: string;
  /** Repository name */
  repo: string;
  /** GitHub Personal Access Token */
  pat: string;
  /** Source branch (head) */
  head: string;
  /** Target branch (base), typically "develop" */
  base: string;
  /** PR title */
  title: string;
  /** PR body (markdown) */
  body: string;
}

export interface PrResult {
  /** Whether the PR was successfully created */
  success: boolean;
  /** The PR URL (html_url) if created successfully */
  prUrl?: string;
  /** The PR number if created successfully */
  prNumber?: number;
  /** Error message if creation failed */
  error?: string;
  /** HTTP status code from the API */
  statusCode?: number;
}

/**
 * Create a GitHub Pull Request via the REST API.
 *
 * Endpoint: POST https://api.github.com/repos/{owner}/{repo}/pulls
 *
 * @returns PrResult with success status, PR URL, or error details.
 */
export async function createPullRequest(options: CreatePrOptions): Promise<PrResult> {
  const { owner, repo, pat, head, base, title, body } = options;

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${pat}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ title, body, head, base }),
    });

    const statusCode = response.status;

    if (statusCode === 201) {
      const data = await response.json() as { html_url: string; number: number };
      return {
        success: true,
        prUrl: data.html_url,
        prNumber: data.number,
        statusCode,
      };
    }

    // Handle known error cases
    const errorData = await response.json().catch(() => ({})) as {
      message?: string;
      errors?: Array<{ message?: string }>;
    };

    let errorMsg = errorData.message || `HTTP ${statusCode}`;
    if (errorData.errors && errorData.errors.length > 0) {
      errorMsg += `: ${errorData.errors.map((e) => e.message).join(", ")}`;
    }

    return {
      success: false,
      error: errorMsg,
      statusCode,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Network error: ${err.message || String(err)}`,
    };
  }
}

/**
 * Build the PR body markdown for a Vibecode Heaven task.
 */
export function buildPrBody(
  taskId: number,
  taskTitle: string,
  taskType: string,
  taskPriority: number,
  taskDescription: string
): string {
  const priorityLabels: Record<number, string> = {
    1: "Critical",
    2: "High",
    3: "Medium",
    4: "Low",
  };

  return [
    "## Task",
    "",
    `**Title:** ${taskTitle}`,
    `**Type:** ${taskType}`,
    `**Priority:** ${taskPriority} (${priorityLabels[taskPriority] || "Unknown"})`,
    `**ID:** ${taskId}`,
    "",
    "## Description",
    "",
    taskDescription || "_(no description provided)_",
    "",
    "---",
    "*Created automatically by Vibecode Heaven*",
  ].join("\n");
}

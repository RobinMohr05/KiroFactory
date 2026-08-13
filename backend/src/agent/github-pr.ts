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
  /** Target branch (base), typically "develop", "dev", or "main" */
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

// ---------------------------------------------------------------------------
// Grouped/shared branch PR helpers
// ---------------------------------------------------------------------------

export interface FindPrOptions {
  owner: string;
  repo: string;
  pat: string;
  head: string;
}

export interface ExistingPr {
  prUrl: string;
  prNumber: number;
  body: string;
}

/**
 * Find an existing open PR for the given head branch.
 *
 * Uses the GitHub REST API: GET /repos/{owner}/{repo}/pulls?head={owner}:{head}&state=open
 *
 * @returns The existing PR info, or null if no open PR exists for that branch.
 */
export async function findExistingPrForBranch(options: FindPrOptions): Promise<ExistingPr | null> {
  const { owner, repo, pat, head } = options;

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${pat}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) return null;

    const data = await response.json() as Array<{ html_url: string; number: number; body: string }>;

    if (data.length === 0) return null;

    return {
      prUrl: data[0].html_url,
      prNumber: data[0].number,
      body: data[0].body || "",
    };
  } catch {
    return null;
  }
}

export interface UpdatePrOptions {
  owner: string;
  repo: string;
  pat: string;
  prNumber: number;
  title: string;
  body: string;
}

export interface UpdatePrResult {
  success: boolean;
  error?: string;
}

/**
 * Update an existing PR's title and body via PATCH.
 *
 * Endpoint: PATCH https://api.github.com/repos/{owner}/{repo}/pulls/{pull_number}
 */
export async function updatePullRequestBody(options: UpdatePrOptions): Promise<UpdatePrResult> {
  const { owner, repo, pat, prNumber, title, body } = options;

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;

  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${pat}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ title, body }),
    });

    if (response.ok) {
      return { success: true };
    }

    const errorData = await response.json().catch(() => ({})) as { message?: string };
    return {
      success: false,
      error: errorData.message || `HTTP ${response.status}`,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Network error: ${err.message || String(err)}`,
    };
  }
}

export interface GroupedTaskInfo {
  id: number;
  title: string;
  type: string;
  priority: number;
  description: string;
}

/**
 * Build a PR body referencing multiple grouped tasks.
 */
export function buildGroupedPrBody(tasks: GroupedTaskInfo[]): string {
  const priorityLabels: Record<number, string> = {
    1: "Critical",
    2: "High",
    3: "Medium",
    4: "Low",
  };

  const sections = tasks.map((task) => [
    `### Task #${task.id}: ${task.title}`,
    "",
    `**Type:** ${task.type} | **Priority:** ${task.priority} (${priorityLabels[task.priority] || "Unknown"})`,
    "",
    task.description || "_(no description provided)_",
  ].join("\n"));

  return [
    "## Tasks",
    "",
    ...sections.map((s, i) => (i > 0 ? "\n" + s : s)),
    "",
    "---",
    "*Created automatically by Vibecode Heaven*",
  ].join("\n");
}

/**
 * Build a PR title referencing grouped tasks.
 *
 * - Single task: "Task title [Vibecode Heaven #ID]"
 * - Multiple tasks: "Grouped tasks [Vibecode Heaven #ID1, #ID2, ...]"
 */
export function buildGroupedPrTitle(tasks: Array<{ id: number; title: string }>): string {
  if (tasks.length === 1) {
    return `${tasks[0].title} [Vibecode Heaven #${tasks[0].id}]`;
  }

  const ids = tasks.map((t) => `#${t.id}`).join(", ");
  return `Grouped tasks [Vibecode Heaven ${ids}]`;
}

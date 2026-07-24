/**
 * Repo URL Parser — Extracts owner/repo from GitHub repository URLs
 *
 * Supports:
 * - https://github.com/{owner}/{repo}
 * - https://github.com/{owner}/{repo}.git
 * - git@github.com:{owner}/{repo}.git
 */

export interface RepoInfo {
  owner: string;
  repo: string;
  /** Directory name for local workspace: "{owner}_{repo}" */
  workspaceDirName: string;
}

/**
 * Parse a GitHub repository URL into owner, repo, and workspace directory name.
 *
 * @throws Error if the URL format is not recognized as a GitHub repository.
 */
export function parseGitHubRepoUrl(url: string): RepoInfo {
  // Trim whitespace
  const trimmed = url.trim();

  // Try HTTPS format: https://github.com/{owner}/{repo}(.git)?
  const httpsMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    const owner = httpsMatch[1];
    const repo = httpsMatch[2];
    return { owner, repo, workspaceDirName: `${owner}_${repo}` };
  }

  // Try SSH format: git@github.com:{owner}/{repo}.git
  const sshMatch = trimmed.match(
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/
  );
  if (sshMatch) {
    const owner = sshMatch[1];
    const repo = sshMatch[2];
    return { owner, repo, workspaceDirName: `${owner}_${repo}` };
  }

  throw new Error(
    `Unrecognized GitHub repository URL format: "${trimmed}". ` +
    `Expected https://github.com/{owner}/{repo} or git@github.com:{owner}/{repo}.git`
  );
}

/**
 * Build an authenticated HTTPS clone URL using a GitHub PAT.
 * The PAT is embedded in the URL for use with git subprocess commands.
 */
export function buildAuthenticatedUrl(owner: string, repo: string, pat: string): string {
  return `https://${pat}@github.com/${owner}/${repo}.git`;
}

/**
 * Slugify a task title for use in a branch name.
 *
 * Rules:
 * - Lowercase
 * - Spaces replaced with hyphens
 * - Strip characters not in [a-z0-9-]
 * - Collapse multiple hyphens into one
 * - Truncate to max 60 characters
 * - Trim trailing hyphens
 */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60)
    .replace(/-+$/, "");
}

/**
 * Build a branch name from task metadata.
 *
 * Format: [task_type]/#[task_id]_[task_title_slug]
 * Example: feature/#42_add-user-login-page
 */
export function buildBranchName(
  taskType: string,
  taskId: number,
  taskTitle: string
): string {
  const slug = slugifyTitle(taskTitle);
  return `${taskType}/#${taskId}_${slug}`;
}

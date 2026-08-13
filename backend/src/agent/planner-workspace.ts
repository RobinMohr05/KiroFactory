/**
 * Planner Workspace Manager — Read-only repo clones for the task planner.
 *
 * Clones a repository into a temporary directory so the planner's kiro-cli
 * session can browse files, read READMEs, and understand the project structure.
 *
 * Unlike the ACA worker (worker/worker.js, which handles full branch/commit/push
 * for task execution), this module is lightweight and read-only: clone, give
 * access, then clean up.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { detectGitProviderFromUrl, type GitProvider } from "../types.js";
import { log, toErrorFields } from "../logger.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PLANNER_WORKSPACE_ROOT = process.env.PLANNER_WORKSPACE_ROOT || "./planner-workspaces";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlannerWorkspaceOptions {
  /** Full repository URL (GitHub or Azure DevOps) */
  repositoryUrl: string;
  /** Git provider (if known) — used to pick the right auth approach */
  gitProvider?: GitProvider | null;
  /** GitHub PAT for private repos (optional — public repos clone without auth) */
  githubPat?: string;
  /** Azure DevOps PAT for private repos (optional) */
  azureDevOpsPat?: string;
}

export interface PlannerWorkspaceResult {
  /** Absolute path to the cloned workspace */
  workspacePath: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an authenticated clone URL based on provider and available credentials.
 * Falls back to the raw URL (unauthenticated, works for public repos).
 */
function buildCloneUrl(options: PlannerWorkspaceOptions): string {
  const { repositoryUrl, gitProvider, githubPat, azureDevOpsPat } = options;
  const provider = gitProvider ?? detectGitProviderFromUrl(repositoryUrl);

  // Strip any existing user info from the URL
  const baseUrl = repositoryUrl.replace(/^(https?:\/\/)[^@/]+@/, "$1");

  if (provider === "github" && githubPat) {
    return baseUrl.replace("https://", `https://x-access-token:${githubPat}@`);
  }

  if (provider === "azure-devops" && azureDevOpsPat) {
    return baseUrl.replace("https://", `https://pat:${azureDevOpsPat}@`);
  }

  // No credentials — attempt unauthenticated clone (works for public repos)
  return baseUrl;
}

/**
 * Generate a unique directory name for a planner workspace.
 * Uses a random suffix to avoid collisions between concurrent planners.
 */
function generateWorkspaceDirName(repositoryUrl: string): string {
  // Extract a short identifier from the URL
  const urlSlug = repositoryUrl
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/[^a-zA-Z0-9]/g, "_")
    .slice(-40);
  const suffix = randomBytes(4).toString("hex");
  return `planner_${urlSlug}_${suffix}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Clone a repository into a temporary workspace for the task planner.
 *
 * Performs a shallow clone (depth 1) of the default branch to minimize download
 * time and disk usage — the planner only needs to browse the current file tree,
 * not the full history.
 *
 * @returns The workspace path on success, or null if cloning fails (non-fatal).
 */
export async function preparePlannerWorkspace(
  options: PlannerWorkspaceOptions
): Promise<PlannerWorkspaceResult | null> {
  const dirName = generateWorkspaceDirName(options.repositoryUrl);
  const workspacePath = resolve(PLANNER_WORKSPACE_ROOT, dirName);

  try {
    // Ensure the root directory exists
    await mkdir(resolve(PLANNER_WORKSPACE_ROOT), { recursive: true });
    await mkdir(workspacePath, { recursive: true });

    const cloneUrl = buildCloneUrl(options);

    // Shallow clone — just the tip of the default branch
    await execFileAsync("git", ["clone", "--depth", "1", cloneUrl, workspacePath], {
      encoding: "utf-8",
      timeout: 120_000, // 2 min timeout for clone
    });

    log.info("planner-workspace-cloned", {
      component: "planner-workspace",
      repositoryUrl: options.repositoryUrl,
      workspacePath,
      msg: `Cloned repository for planner: ${options.repositoryUrl}`,
    });

    return { workspacePath };
  } catch (err) {
    log.warn("planner-workspace-clone-failed", {
      component: "planner-workspace",
      repositoryUrl: options.repositoryUrl,
      workspacePath,
      ...toErrorFields(err),
      msg: `Failed to clone repository for planner: ${options.repositoryUrl}`,
    });

    // Clean up the failed directory
    try {
      await rm(workspacePath, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }

    return null;
  }
}

/**
 * Clean up a planner workspace directory.
 * Call this when the planner session is closed or deleted.
 */
export async function cleanupPlannerWorkspace(workspacePath: string): Promise<void> {
  if (!workspacePath || !existsSync(workspacePath)) return;

  // Safety check: only remove paths within the planner workspace root
  const root = resolve(PLANNER_WORKSPACE_ROOT);
  const target = resolve(workspacePath);
  if (!target.startsWith(root)) {
    log.warn("planner-workspace-cleanup-rejected", {
      component: "planner-workspace",
      workspacePath,
      root,
      msg: `Refusing to clean up path outside planner workspace root: ${workspacePath}`,
    });
    return;
  }

  try {
    await rm(workspacePath, { recursive: true, force: true });
    log.info("planner-workspace-cleaned", {
      component: "planner-workspace",
      workspacePath,
      msg: `Cleaned up planner workspace: ${workspacePath}`,
    });
  } catch (err) {
    log.warn("planner-workspace-cleanup-failed", {
      component: "planner-workspace",
      workspacePath,
      ...toErrorFields(err),
      msg: `Failed to clean up planner workspace: ${workspacePath}`,
    });
  }
}

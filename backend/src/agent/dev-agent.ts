/**
 * Developer Agent — Main Entry Point
 *
 * A standalone agent that:
 * 1. Claims the highest-priority todo task from the database
 * 2. Resolves the repository URL from the task's tab
 * 3. Prepares the workspace (clone or pull develop/dev/main)
 * 4. Creates a feature branch from the base branch
 * 5. Spawns a kiro-cli ACP session to work on the task
 * 6. Commits & pushes changes to the feature branch
 * 7. Creates a Pull Request on GitHub via REST API
 * 8. Marks the task as "developed"
 *
 * Usage:
 *   npx tsx src/agent/dev-agent.ts
 *   npx tsx src/agent/dev-agent.ts --task 5          (claim specific task)
 *   npx tsx src/agent/dev-agent.ts --agent my-agent  (use specific agent)
 *   npx tsx src/agent/dev-agent.ts --loop            (continuous mode)
 *   npx tsx src/agent/dev-agent.ts --timeout 600     (10 min timeout)
 */

import dotenv from "dotenv";
dotenv.config();

import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { KiroRunner } from "./kiro-runner.js";
import { claimTask, markTaskDeveloped, resetTaskToTodo, getAvailableTaskCount, getTasksByBranch } from "./task-claimer.js";
import { buildDevPrompt, buildTddDevPrompt } from "./prompt-builder.js";
import { parseGitHubRepoUrl } from "./repo-url-parser.js";
import { prepareWorkspace, installDependencies, createFeatureBranch, checkoutExistingBranch, commitChanges, pushBranch } from "./git-workspace.js";
import { createPullRequest, buildPrBody, findExistingPrForBranch, updatePullRequestBody, buildGroupedPrBody, buildGroupedPrTitle } from "./github-pr.js";
import { resolveBranchForTask } from "./dev-agent-helpers.js";
import { getDecryptedCredential } from "../db/credentials.js";
import { setTaskBranchAndPr } from "../db/tasks.js";
import { closePool } from "../db/connection.js";
import type { ClaimedTask } from "./task-claimer.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface AgentConfig {
  /** Kiro agent name (from .kiro/agents/) */
  agent: string;
  /** Timeout per task in seconds */
  timeoutSeconds: number;
  /** Run continuously (claim next task after completing one) */
  loop: boolean;
  /** Wait time between iterations in loop mode (seconds) */
  intervalSeconds: number;
  /** Specific task ID to claim (optional) */
  taskId?: number;
  /** Optional model override */
  model?: string;
  /** Use TDD prompt (Red-Green-Refactor workflow) */
  tdd: boolean;
}

function parseArgs(): AgentConfig {
  const args = process.argv.slice(2);
  const config: AgentConfig = {
    agent: "developer-agent",
    timeoutSeconds: 900, // 15 minutes default
    loop: false,
    intervalSeconds: 10,
    tdd: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--agent":
        config.agent = args[++i];
        break;
      case "--timeout":
        config.timeoutSeconds = parseInt(args[++i], 10);
        break;
      case "--loop":
        config.loop = true;
        break;
      case "--interval":
        config.intervalSeconds = parseInt(args[++i], 10);
        break;
      case "--task":
        config.taskId = parseInt(args[++i], 10);
        break;
      case "--model":
        config.model = args[++i];
        break;
      case "--tdd":
        config.tdd = true;
        break;
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg: string, color?: "cyan" | "yellow" | "green" | "red" | "gray"): void {
  const colors: Record<string, string> = {
    cyan: "\x1b[36m",
    yellow: "\x1b[33m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    gray: "\x1b[90m",
  };
  const reset = "\x1b[0m";
  const prefix = color ? colors[color] : "";
  const suffix = color ? reset : "";
  console.log(`${prefix}[${timestamp()}] ${msg}${suffix}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip ANSI escape codes from text for clean output. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Kill any orphaned kiro-cli.exe processes (Windows only).
 * Safety net for processes left over from crashed previous runs.
 */
async function cleanupOrphanedProcesses(): Promise<void> {
  if (process.platform !== "win32") return;

  try {
    const psCommand =
      "Get-CimInstance Win32_Process -Filter \"Name='kiro-cli.exe'\" " +
      "| Where-Object { $_.CommandLine -match 'acp' } " +
      "| Select-Object -ExpandProperty ProcessId";

    const output = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", psCommand],
      { encoding: "utf-8", timeout: 10_000 }
    ).trim();

    const pids = output
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s));

    if (pids.length === 0) return;

    log(`Cleaning up ${pids.length} orphaned kiro-cli process(es)...`, "yellow");
    for (const pid of pids) {
      try {
        execFileSync("taskkill", ["/PID", pid, "/T", "/F"], {
          timeout: 5_000,
          stdio: "ignore",
        });
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

async function executeAgent(
  prompt: string,
  cwd: string,
  config: AgentConfig
): Promise<boolean> {
  let runner: KiroRunner | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  try {
    log(`Starting kiro-cli acp --agent ${config.agent}...`, "gray");

    runner = await KiroRunner.create({
      agent: config.agent,
      cwd,
      model: config.model,
    });

    log(`ACP session established (PID: ${runner.pid})`, "gray");

    // Set up timeout
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        log(`TIMEOUT: exceeded ${config.timeoutSeconds}s`, "red");
        resolve();
      }, config.timeoutSeconds * 1000);
    });

    // Run the prompt with streaming output
    const promptLoop = async () => {
      for await (const update of runner!.prompt(prompt)) {
        if (timedOut) break;

        if (update.sessionUpdate) {
          switch (update.sessionUpdate) {
            case "agent_message_chunk":
              if (update.content && typeof update.content.text === "string") {
                const text = stripAnsi(update.content.text);
                process.stdout.write(text);
              }
              break;

            case "tool_call":
              if (update.title) {
                const status = update.status || "";
                log(`  [Tool] ${update.title} (${status})`, "gray");
              }
              break;

            case "tool_call_update":
              if (update.status === "completed") {
                log(`  Tool completed.`, "green");
              }
              break;
          }
        }
      }
    };

    // Race: prompt completion vs timeout
    await Promise.race([promptLoop(), timeoutPromise]);

    if (timeoutHandle) clearTimeout(timeoutHandle);

    return !timedOut;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`ERROR: ${msg}`, "red");
    return false;
  } finally {
    if (runner) {
      try {
        await runner.close();
      } catch {
        /* best effort */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Single task execution — full workflow
// ---------------------------------------------------------------------------

async function runOnce(config: AgentConfig): Promise<boolean> {
  // 1. Claim a task
  log("Claiming next task...", "cyan");

  const task = await claimTask(config.taskId);

  if (!task) {
    log("No available tasks to claim.", "yellow");
    return false;
  }

  log(
    `Claimed: [P${task.priority}] "${task.title}" (ID: ${task.id}, type: ${task.type})`,
    "green"
  );

  // 2. Resolve repository URL
  if (!task.repositoryUrl) {
    log(`ERROR: Task #${task.id} has no repository URL (tab has no repository configured).`, "red");
    await resetTaskToTodo(task.id);
    log(`Task ${task.id} reset to "todo".`, "red");
    return false;
  }

  log(`Repository: ${task.repositoryUrl}`, "gray");

  let repoInfo;
  try {
    repoInfo = parseGitHubRepoUrl(task.repositoryUrl);
  } catch (err: any) {
    log(`ERROR: ${err.message}`, "red");
    await resetTaskToTodo(task.id);
    log(`Task ${task.id} reset to "todo".`, "red");
    return false;
  }

  // 3. Get GitHub PAT for authentication
  if (!task.userId) {
    log(`ERROR: Task #${task.id} has no associated user (cannot retrieve credentials).`, "red");
    await resetTaskToTodo(task.id);
    log(`Task ${task.id} reset to "todo".`, "red");
    return false;
  }

  const githubPat = await getDecryptedCredential(task.userId, "githubPat");
  if (!githubPat) {
    log(`ERROR: No GitHub PAT configured for user ${task.userId}. Set it via credentials API.`, "red");
    await resetTaskToTodo(task.id);
    log(`Task ${task.id} reset to "todo".`, "red");
    return false;
  }

  // 4. Prepare workspace (clone or pull develop/dev/main)
  let workspacePath: string;
  let baseBranch: string;
  try {
    log(`Preparing workspace for ${repoInfo.owner}/${repoInfo.repo}...`, "cyan");
    const result = await prepareWorkspace(repoInfo, githubPat);
    workspacePath = result.workspacePath;
    baseBranch = result.baseBranch;
    log(`Workspace ready: ${workspacePath} (branch: ${baseBranch})`, "green");
  } catch (err: any) {
    log(`ERROR preparing workspace: ${err.message}`, "red");
    await resetTaskToTodo(task.id);
    log(`Task ${task.id} reset to "todo".`, "red");
    return false;
  }

  // 4b. Install dependencies so the agent can actually build/test its work.
  // Best-effort: a failure here shouldn't block the task (e.g. doc-only
  // changes don't need node_modules), so just warn and continue.
  try {
    log(`Installing dependencies...`, "cyan");
    await installDependencies(workspacePath);
    log(`Dependencies installed.`, "green");
  } catch (err: any) {
    log(`WARNING: dependency install failed: ${err.message}`, "yellow");
  }

  // 5. Resolve branch — existing shared branch or create new
  //
  // AC#1: If task.branch is pre-set, check out that existing branch.
  // AC#2: Grouping is achieved by pre-setting `branch` on all tasks in a group
  //        before they are claimed (e.g., via the API or UI). This avoids
  //        false matches from implicit heuristics like "same tab." The helper
  //        `findSharedBranchInTab()` exists for tooling that wants to suggest
  //        a group branch, but is NOT called implicitly during task execution.
  // AC#4: If no branch exists, fall back to creating a new feature branch.
  let branchName: string;
  try {
    const resolution = resolveBranchForTask(task);

    if (resolution.isExisting && resolution.branchName) {
      // Task has a pre-assigned branch (AC#1 / AC#2 via pre-set) — check it out
      branchName = await checkoutExistingBranch(workspacePath, resolution.branchName);
      log(`Checked out existing branch: ${branchName}`, "green");
    } else {
      // No existing branch — create a new feature branch (AC#4)
      branchName = await createFeatureBranch(workspacePath, task.type, task.id, task.title);
      log(`Created branch: ${branchName}`, "green");

      // Persist the new branch name back to the task in DB (preserving existing PR URL)
      await setTaskBranchAndPr(task.id, branchName, task.pullRequestUrl);
    }
  } catch (err: any) {
    log(`ERROR with branch: ${err.message}`, "red");
    await resetTaskToTodo(task.id);
    log(`Task ${task.id} reset to "todo".`, "red");
    return false;
  }

  // 6. Execute agent on the feature branch
  const prompt = config.tdd
    ? buildTddDevPrompt(task, workspacePath)
    : buildDevPrompt(task, workspacePath);

  const agentSuccess = await executeAgent(prompt, workspacePath, config);

  if (!agentSuccess) {
    log(`Agent failed or timed out for task ${task.id}.`, "red");

    // Best-effort: try to commit & push whatever the agent produced
    let failBranch: string | null = null;
    let failPrUrl: string | null = null;
    try {
      const hasFailChanges = await commitChanges(
        workspacePath, task.id, task.title, task.type, task.priority, task.description
      );
      if (hasFailChanges) {
        await pushBranch(workspacePath, branchName);
        failBranch = branchName;
        log(`Best-effort push to "${branchName}" succeeded.`, "yellow");
        // Attempt PR creation too (best-effort)
        try {
          const prTitle = `[WIP] ${task.title} [Vibecode Heaven #${task.id}]`;
          const prBody = buildPrBody(task.id, task.title, task.type, task.priority, task.description);
          const failPrResult = await createPullRequest({
            owner: repoInfo.owner,
            repo: repoInfo.repo,
            pat: githubPat,
            head: branchName,
            base: baseBranch,
            title: prTitle,
            body: prBody,
          });
          if (failPrResult.success) {
            failPrUrl = failPrResult.prUrl ?? null;
            log(`Best-effort PR created: ${failPrUrl}`, "yellow");
          }
        } catch { /* best effort — ignore PR creation failure */ }
      }
    } catch {
      // Best effort — push failed or nothing to push
    }

    await resetTaskToTodo(task.id, failBranch, failPrUrl);
    log(`Task ${task.id} reset to "todo".`, "red");
    return false;
  }

  // 7. Commit changes
  let hasChanges: boolean;
  try {
    hasChanges = await commitChanges(
      workspacePath,
      task.id,
      task.title,
      task.type,
      task.priority,
      task.description
    );

    if (!hasChanges) {
      log(`No changes after agent execution — task may already be implemented.`, "yellow");
      // Still mark as developed (the agent determined nothing needed doing)
      await markTaskDeveloped(task.id, branchName, null);
      log(`Task ${task.id} marked as "developed" (no changes needed).`, "green");
      return true;
    }

    log(`Changes committed successfully.`, "green");
  } catch (err: any) {
    log(`ERROR committing: ${err.message}`, "red");
    await resetTaskToTodo(task.id);
    log(`Task ${task.id} reset to "todo".`, "red");
    return false;
  }

  // 8. Push branch
  try {
    log(`Pushing branch "${branchName}" to origin...`, "cyan");
    await pushBranch(workspacePath, branchName);
    log(`Branch pushed successfully.`, "green");
  } catch (err: any) {
    log(`ERROR pushing: ${err.message}`, "red");
    await resetTaskToTodo(task.id);
    log(`Task ${task.id} reset to "todo".`, "red");
    return false;
  }

  // 9. Create or update Pull Request
  log(`Checking for existing PR on branch "${branchName}"...`, "cyan");

  let prUrl: string | null = null;

  // Check if a PR already exists for this branch (shared branch scenario)
  const existingPr = await findExistingPrForBranch({
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    pat: githubPat,
    head: branchName,
  });

  if (existingPr) {
    // PR already exists — update its title and body to reference all tasks in the group
    log(`Existing PR found: ${existingPr.prUrl} — updating...`, "cyan");

    const siblingTasks = await getTasksByBranch(branchName);
    const groupedTitle = buildGroupedPrTitle(siblingTasks);
    const groupedBody = buildGroupedPrBody(siblingTasks);

    const updateResult = await updatePullRequestBody({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      pat: githubPat,
      prNumber: existingPr.prNumber,
      title: groupedTitle,
      body: groupedBody,
    });

    if (!updateResult.success) {
      log(`WARNING: Failed to update PR body: ${updateResult.error}`, "yellow");
    } else {
      log(`PR updated with grouped task references.`, "green");
    }

    prUrl = existingPr.prUrl;
  } else {
    // No existing PR — create a new one
    log(`Creating Pull Request...`, "cyan");

    // If this branch has multiple tasks already, create a grouped PR
    const siblingTasks = await getTasksByBranch(branchName);
    let prTitle: string;
    let prBody: string;

    if (siblingTasks.length > 1) {
      prTitle = buildGroupedPrTitle(siblingTasks);
      prBody = buildGroupedPrBody(siblingTasks);
    } else {
      prTitle = `${task.title} [Vibecode Heaven #${task.id}]`;
      prBody = buildPrBody(task.id, task.title, task.type, task.priority, task.description);
    }

    const prResult = await createPullRequest({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      pat: githubPat,
      head: branchName,
      base: baseBranch,
      title: prTitle,
      body: prBody,
    });

    if (!prResult.success) {
      // PR creation failed but code is pushed — leave task in-progress for manual intervention
      log(`ERROR creating PR: ${prResult.error} (HTTP ${prResult.statusCode || "N/A"})`, "red");
      log(`Code is pushed to branch "${branchName}" — manual PR creation required.`, "yellow");
      log(`Task ${task.id} left as "in-progress" (needs manual intervention).`, "yellow");
      return false;
    }

    prUrl = prResult.prUrl ?? null;
    log(`Pull Request created: ${prUrl}`, "green");
  }

  // 10. Mark task as developed
  await markTaskDeveloped(task.id, branchName, prUrl);
  log(`Task ${task.id} marked as "developed" ✓`, "green");

  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = parseArgs();

  log("════════════════════════════════════════════════════════", "cyan");
  log("  Vibecode Heaven — Developer Agent", "cyan");
  log(`  Agent: ${config.agent}`, "cyan");
  log(`  Timeout: ${config.timeoutSeconds}s | Loop: ${config.loop} | TDD: ${config.tdd}`, "cyan");
  if (config.taskId) {
    log(`  Target task: #${config.taskId}`, "cyan");
  }
  log("════════════════════════════════════════════════════════", "cyan");
  log("", undefined);

  // Cleanup orphaned processes from previous crashed runs
  await cleanupOrphanedProcesses();

  // Graceful shutdown handler
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(1);
    stopping = true;
    log("Received SIGINT, finishing current task...", "yellow");
  });

  if (config.loop) {
    // Continuous mode: keep claiming and executing tasks
    let iteration = 0;

    while (!stopping) {
      iteration++;
      log(`─── Iteration ${iteration} ───`, "yellow");

      const todoCount = await getAvailableTaskCount();
      if (todoCount === 0) {
        log(`No todo tasks available. Waiting ${config.intervalSeconds}s...`, "yellow");
        await sleep(config.intervalSeconds * 1000);
        if (stopping) break;
        continue;
      }

      log(`${todoCount} task(s) available`, "gray");

      const startTime = Date.now();
      const success = await runOnce(config);
      const duration = Math.round((Date.now() - startTime) / 1000);

      if (success) {
        log(`Iteration ${iteration} done. (${duration}s)`, "green");
      } else {
        log(`Iteration ${iteration} ended with issues. (${duration}s)`, "red");
      }

      if (stopping) break;

      // Wait between iterations
      if (config.intervalSeconds > 0) {
        log(`Next iteration in ${config.intervalSeconds}s...`, "gray");
        await sleep(config.intervalSeconds * 1000);
      }

      log("", undefined);
    }
  } else {
    // Single-shot mode: claim one task and exit
    await runOnce(config);
  }

  // Cleanup
  await closePool();
  log("Agent shutdown complete.", "cyan");
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  try { await closePool(); } catch { /* best effort */ }
  process.exit(1);
});

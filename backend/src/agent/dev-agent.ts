/**
 * Developer Agent — Main Entry Point
 *
 * A standalone agent that:
 * 1. Claims the highest-priority todo task from the database
 * 2. Spawns a kiro-cli ACP session to work on it
 * 3. Streams output and tracks progress
 * 4. Marks the task as "developed" on success, or resets to "todo" on failure
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
import { claimTask, markTaskDeveloped, resetTaskToTodo, getAvailableTaskCount } from "./task-claimer.js";
import { buildDevPrompt } from "./prompt-builder.js";
import { closePool } from "../db/connection.js";
import type { ClaimedTask } from "./task-claimer.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface AgentConfig {
  /** Kiro agent name (from .kiro/agents/) */
  agent: string;
  /** Working directory for kiro-cli */
  cwd: string;
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
}

function parseArgs(): AgentConfig {
  const args = process.argv.slice(2);
  const config: AgentConfig = {
    agent: "developer-agent",
    cwd: resolve(import.meta.dirname, "../../.."), // project root
    timeoutSeconds: 900, // 15 minutes default
    loop: false,
    intervalSeconds: 10,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--agent":
        config.agent = args[++i];
        break;
      case "--cwd":
        config.cwd = resolve(args[++i]);
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
// Single task execution
// ---------------------------------------------------------------------------

async function executeTask(
  task: ClaimedTask,
  config: AgentConfig
): Promise<boolean> {
  let runner: KiroRunner | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const prompt = buildDevPrompt(task, config.cwd);

  try {
    log(`Starting kiro-cli acp --agent ${config.agent}...`, "gray");

    runner = await KiroRunner.create({
      agent: config.agent,
      cwd: config.cwd,
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
// Main
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

  // 2. Execute the task
  const success = await executeTask(task, config);

  // 3. Update task state based on result
  if (success) {
    await markTaskDeveloped(task.id);
    log(`Task ${task.id} marked as "developed" ✓`, "green");
  } else {
    await resetTaskToTodo(task.id);
    log(`Task ${task.id} reset to "todo" (agent failed or timed out)`, "red");
  }

  return success;
}

async function main(): Promise<void> {
  const config = parseArgs();

  log("════════════════════════════════════════════════════════", "cyan");
  log("  KiroFactory — Developer Agent", "cyan");
  log(`  Agent: ${config.agent}`, "cyan");
  log(`  CWD: ${config.cwd}`, "cyan");
  log(`  Timeout: ${config.timeoutSeconds}s | Loop: ${config.loop}`, "cyan");
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

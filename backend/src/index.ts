import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";

import { setupWebSocket, broadcast } from "./websocket-handler.js";
import tasksRouter from "./routes/tasks.js";
import boardsRouter from "./routes/boards.js";
import sessionsRouter from "./routes/sessions.js";
import agentsRouter from "./routes/agents.js";
import errorsRouter from "./routes/errors.js";
import { runMigration } from "./db/migrate.js";
import { tryConnect, isDbAvailable, closePool } from "./db/connection.js";
import { shutdownAllSessions, initSessions } from "./session-manager.js";
import { getChangedTasksSince } from "./db/tasks.js";
import { wasRecentlyBroadcast } from "./broadcast-tracker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from frontend/public directory
app.use(express.static(path.join(__dirname, "../../frontend/public")));

// Mount API routes (with DB availability guard)
import type { Request, Response, NextFunction } from "express";

function requireDb(req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) {
    res.status(503).json({
      error: "Database is currently unavailable. Some features may not work until the connection is restored.",
    });
    return;
  }
  next();
}

app.use("/api/tasks", requireDb, tasksRouter);
app.use("/api/boards", requireDb, boardsRouter);
app.use("/api/sessions", sessionsRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/errors", errorsRouter);

// Health endpoint
app.get("/api/health", (_req, res) => {
  res.json({
    status: "running",
    database: isDbAvailable() ? "connected" : "unavailable",
  });
});

// Create HTTP server and attach WebSocket
const server = createServer(app);
setupWebSocket(server);

// ─── DB Change Detector (poll loop) ─────────────────────────────────────────

let lastPollTime = new Date().toISOString();
let pollInterval: ReturnType<typeof setInterval> | null = null;

async function pollForChanges(): Promise<void> {
  if (!isDbAvailable()) {
    return; // Skip polling when DB is down — no noise in the logs
  }

  try {
    const changedTasks = await getChangedTasksSince(lastPollTime);
    const now = new Date().toISOString();
    if (changedTasks.length > 0) {
      for (const task of changedTasks) {
        // Skip tasks that were recently broadcast by REST routes (avoid duplicates)
        if (wasRecentlyBroadcast(task.id)) {
          continue;
        }
        broadcast({ type: "task-updated", task });
      }
    }
    lastPollTime = now;
  } catch (err) {
    // Connection may have dropped mid-session — log once and keep going
    console.warn("[poll] ⚠ Poll cycle failed — will retry on next interval.");
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3500;

async function start(): Promise<void> {
  // Restore sessions from disk (before DB — sessions don't require DB)
  initSessions();

  // Attempt database connection — non-fatal if it fails
  await tryConnect();

  if (isDbAvailable()) {
    await runMigration();
    console.log("[startup] Database ready.");
  } else {
    console.warn(
      "[startup] ⚠ Server starting WITHOUT database connectivity."
    );
    console.warn(
      "[startup] ⚠ The UI will load but task/board features will be unavailable until the DB is reachable."
    );
  }

  server.listen(PORT, () => {
    console.log(`KiroFactory server running on http://localhost:${PORT}`);
  });

  // Start the change detector poll loop
  pollInterval = setInterval(pollForChanges, 1500);
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  console.log("\nShutting down...");
  if (pollInterval) {
    clearInterval(pollInterval);
  }

  await shutdownAllSessions();
  server.close();
  try {
    await closePool();
  } catch {
    // Pool may not be connected
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
start();

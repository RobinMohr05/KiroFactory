import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";

import { setupWebSocket, broadcast } from "./websocket-handler.js";
import { setupWorkerWebSocket } from "./worker-ws-handler.js";
import { isAcaModeEnabled } from "./aca-worker-spawner.js";
import { requireAuth, isPublicPath } from "./middleware/auth.js";
import authRouter from "./routes/auth.js";
import tasksRouter from "./routes/tasks.js";
import tabsRouter from "./routes/tabs.js";
import sessionsRouter from "./routes/sessions.js";
import agentsRouter from "./routes/agents.js";
import errorsRouter from "./routes/errors.js";
import credentialsRouter from "./routes/credentials.js";
import adminRouter from "./routes/admin.js";
import { runMigration } from "./db/migrate.js";
import { tryConnect, isDbAvailable, closePool, getPoolStats } from "./db/connection.js";
import { shutdownAllSessions, initSessions } from "./session-manager.js";
import { getChangedTasksSince } from "./db/tasks.js";
import { wasRecentlyBroadcast } from "./broadcast-tracker.js";
import { apiErrorLogger, uncaughtErrorLogger } from "./middleware/error-logger.js";
import { logPoolMetrics } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// CORS: In production (ACA), frontend and API share the same origin (*.azurecontainerapps.io)
// so CORS is effectively same-origin. In development, allow localhost origins.
const corsOrigin = process.env.NODE_ENV === "production"
  ? false // Same-origin only — no cross-origin requests needed
  : true; // Development: allow all origins for convenience
app.use(cors({ origin: corsOrigin }));
app.use(express.json());
app.use(cookieParser());

// Serve static files from frontend/public directory
app.use(express.static(path.join(__dirname, "../../frontend/public")));

// API error logger — attaches a `finish` listener to detect 5xx responses for Azure Monitor
app.use(apiErrorLogger);

// Mount API routes (with DB availability guard and auth)
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

// Global auth guard for /api/* routes — skips public paths
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  // Strip the /api prefix to get the relative path for public path checking
  const relativePath = req.path; // Already relative since we mounted on /api
  if (isPublicPath(relativePath)) {
    next();
    return;
  }
  requireAuth(req, res, next);
});

// Health endpoint (public — listed in PUBLIC_PATHS)
app.get("/api/health", (_req, res) => {
  res.json({
    status: "running",
    database: isDbAvailable() ? "connected" : "unavailable",
  });
});

app.use("/api/auth", requireDb, authRouter);
app.use("/api/tasks", requireDb, tasksRouter);
app.use("/api/tabs", requireDb, tabsRouter);
app.use("/api/sessions", sessionsRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/errors", errorsRouter);
app.use("/api/users/me/credentials", requireDb, credentialsRouter);
app.use("/api/admin", requireDb, adminRouter);

// Error-handling middleware — catches unhandled errors from route handlers and logs them
// as structured JSON for Azure Monitor (must be registered AFTER all route handlers).
app.use(uncaughtErrorLogger);

// Create HTTP server and attach WebSocket
const server = createServer(app);
setupWebSocket(server);

// Attach internal worker WebSocket endpoint (/internal/worker) when ACA mode is available
if (isAcaModeEnabled()) {
  setupWorkerWebSocket(server);
  console.log("[startup] Worker WebSocket endpoint enabled at /internal/worker");
}

// ─── DB Change Detector (poll loop) ─────────────────────────────────────────

let lastPollTime = new Date().toISOString();
let pollInterval: ReturnType<typeof setInterval> | null = null;
let poolMetricsInterval: ReturnType<typeof setInterval> | null = null;

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
  // Attempt database connection — non-fatal if it fails
  await tryConnect();

  if (isDbAvailable()) {
    await runMigration();
    console.log("[startup] Database ready.");

    // Restore sessions from DB (requires DB connection)
    await initSessions();
  } else {
    console.warn(
      "[startup] ⚠ Server starting WITHOUT database connectivity."
    );
    console.warn(
      "[startup] ⚠ The UI will load but task/tab features will be unavailable until the DB is reachable."
    );
  }

  server.listen(PORT, () => {
    console.log(`KiroFactory server running on http://localhost:${PORT}`);
  });

  // Start the change detector poll loop
  pollInterval = setInterval(pollForChanges, 1500);

  // Start periodic pool metrics emission (every 60s) for Azure Monitor dashboard
  poolMetricsInterval = setInterval(() => {
    if (!isDbAvailable()) return;
    const stats = getPoolStats();
    if (stats) {
      logPoolMetrics(stats);
    }
  }, 60_000);
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

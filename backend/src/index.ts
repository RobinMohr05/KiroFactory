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
import { isAcaModeEnabled, loadAcaConfig, verifyAcaAccess } from "./aca-worker-spawner.js";
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
import { log, logPoolMetrics } from "./logger.js";

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

// Create HTTP server and WebSocket servers.
//
// Both WebSocket servers run in `noServer` mode and a single `upgrade` handler
// routes requests by path. This is required: attaching multiple WebSocketServer
// instances to the same HTTP server via the `{ server, path }` option makes each
// instance destroy (abortHandshake) upgrade requests that don't match its path,
// so the first-registered server kills requests destined for the others. That
// bug made "/internal/worker" permanently unreachable while "/ws" worked, which
// is why ACA workers could never connect back to the orchestrator.
const server = createServer(app);
const clientWss = setupWebSocket();

// Enable the internal worker WebSocket endpoint (/internal/worker) when ACA mode is available.
const workerWss = isAcaModeEnabled() ? setupWorkerWebSocket() : null;
if (workerWss) {
  log.info("worker-ws-enabled", {
    component: "startup",
    path: "/internal/worker",
    msg: "Worker WebSocket endpoint enabled",
  });
}

server.on("upgrade", (req, socket, head) => {
  let pathname: string;
  try {
    pathname = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname === "/ws") {
    clientWss.handleUpgrade(req, socket, head, (ws) => clientWss.emit("connection", ws, req));
  } else if (workerWss && pathname === "/internal/worker") {
    workerWss.handleUpgrade(req, socket, head, (ws) => workerWss.emit("connection", ws, req));
  } else {
    // Unknown WebSocket path — reject cleanly.
    socket.destroy();
  }
});

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
    // Connection may have dropped mid-session — will retry on next interval.
    log.warn("poll-failed", {
      component: "poll",
      msg: "Task change poll cycle failed; will retry on next interval",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3500;

async function start(): Promise<void> {
  // Attempt database connection — non-fatal if it fails
  await tryConnect();

  if (isDbAvailable()) {
    await runMigration();
    log.info("db-ready", { component: "startup", msg: "Database migrated and ready" });

    // Restore sessions from DB (requires DB connection)
    await initSessions();
  } else {
    log.warn("db-unavailable-at-startup", {
      component: "startup",
      msg: "Server starting WITHOUT database connectivity — task/tab features unavailable until the DB is reachable",
    });
  }

  server.listen(PORT, () => {
    log.info("server-listening", {
      component: "startup",
      port: PORT,
      msg: `KiroFactory server running on http://localhost:${PORT}`,
    });
  });

  // ACA preflight: verify the managed identity can operate the worker job.
  // Non-blocking and non-fatal — it just surfaces RBAC/identity problems at boot
  // (a missing "Container Apps Jobs Operator" role) instead of at the first session start.
  if (isAcaModeEnabled()) {
    const acaConfig = loadAcaConfig();
    if (acaConfig) {
      verifyAcaAccess(acaConfig)
        .then((check) => {
          if (check.ok) {
            log.info("aca-preflight-ok", { component: "startup", msg: check.message });
          } else {
            log.error("aca-preflight-failed", {
              component: "startup",
              msg: `ACA preflight failed — ${check.message}`,
            });
          }
        })
        .catch(() => {
          /* verifyAcaAccess never throws; this is a safety net only */
        });
    }
  }

  // Start the change detector poll loop
  pollInterval = setInterval(pollForChanges, 1500);

  // Start pool metrics sampling. Rather than emit an identical "all is well"
  // snapshot every minute (pure noise), we only log when the numbers carry
  // signal: the pool is under back-pressure, it's actively in use, the values
  // changed since the last emission, or a rare idle heartbeat is due.
  poolMetricsInterval = setInterval(samplePoolMetrics, POOL_SAMPLE_INTERVAL_MS);
}

// ─── Pool metrics sampling ───────────────────────────────────────────────────

const POOL_SAMPLE_INTERVAL_MS = 60_000;
// Emit at most one "idle/unchanged" heartbeat every 30 minutes so the dashboard
// can confirm the pool is alive without flooding the logs.
const POOL_HEARTBEAT_MS = 30 * 60_000;

let lastPoolSignature: string | null = null;
let lastPoolEmitAt = 0;

function samplePoolMetrics(): void {
  if (!isDbAvailable()) return;
  const stats = getPoolStats();
  if (!stats) return;

  // Back-pressure: callers are queued waiting for a connection, or every
  // connection is checked out. This is the actionable signal worth a warning.
  const pressure = stats.poolPending > 0 || stats.poolBorrowed >= stats.poolSize;
  const active = stats.poolBorrowed > 0 || stats.poolPending > 0;

  const signature = `${stats.poolSize}/${stats.poolAvailable}/${stats.poolPending}/${stats.poolBorrowed}`;
  const changed = signature !== lastPoolSignature;
  const heartbeatDue = Date.now() - lastPoolEmitAt >= POOL_HEARTBEAT_MS;

  if (pressure || active || changed || heartbeatDue) {
    logPoolMetrics(stats, {
      pressure,
      reason: pressure
        ? "connection pool saturated"
        : active
          ? "pool in use"
          : changed
            ? "pool state changed"
            : "heartbeat",
    });
    lastPoolSignature = signature;
    lastPoolEmitAt = Date.now();
  }
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  log.info("shutdown", { component: "startup", msg: "Shutting down..." });
  if (pollInterval) {
    clearInterval(pollInterval);
  }
  if (poolMetricsInterval) {
    clearInterval(poolMetricsInterval);
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

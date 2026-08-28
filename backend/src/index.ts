import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { setupWebSocket } from "./websocket-handler.js";
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
import taskPlannerRouter, { plannerPool } from "./routes/task-planner.js";
import usageRouter from "./routes/usage.js";
import { runMigration } from "./db/migrate.js";
import { tryConnect, isDbAvailable, closePool } from "./db/connection.js";
import { shutdownAllSessions, initSessions } from "./session-manager.js";
import { apiErrorLogger, uncaughtErrorLogger } from "./middleware/error-logger.js";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// CORS: In production (ACA), frontend and API share the same origin (*.azurecontainerapps.io)
// so CORS is effectively same-origin. In development, allow localhost origins.
const corsOrigin = process.env.NODE_ENV === "production"
  ? false // Same-origin only — no cross-origin requests needed
  : true; // Development: allow all origins for convenience
app.use(cors({ origin: corsOrigin }));
// Route-specific body-parser limit for task-planner (image uploads send base64 in JSON,
// easily exceeding the default 100KB). Must be registered BEFORE the global parser so
// that large payloads to this path are parsed here rather than rejected by the default.
app.use("/api/task-planner", express.json({ limit: "15mb" }));
app.use(express.json());
app.use(cookieParser());

// Serve static files: Vite build output first, then legacy public/ (login.html, impressum.html, etc.)
app.use(express.static(path.join(__dirname, "../../frontend/dist")));
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
app.use("/api/task-planner", requireDb, taskPlannerRouter);
app.use("/api/usage", requireDb, usageRouter);

// Error-handling middleware — catches unhandled errors from route handlers and logs them
// as structured JSON for Azure Monitor (must be registered AFTER all route handlers).
app.use(uncaughtErrorLogger);

// SPA catch-all: serve the React app's index.html for any non-API, non-static GET request.
// This must be AFTER all API routes and static middleware, but BEFORE the HTTP server setup.
app.get("*", (req, res) => {
  // Don't intercept API paths or known static files (login.html, impressum.html)
  if (req.path.startsWith("/api/") || req.path.startsWith("/internal/")) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const distIndex = path.join(__dirname, "../../frontend/dist/index.html");
  res.sendFile(distIndex, (err) => {
    if (err) {
      // Fallback to legacy public/index.html if Vite build not available
      const publicIndex = path.join(__dirname, "../../frontend/public/index.html");
      res.sendFile(publicIndex, (err2) => {
        if (err2) res.status(404).send("Not found");
      });
    }
  });
});

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

// ─── Startup ─────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3500;

async function start(): Promise<void> {
  // Bind the port immediately rather than waiting on DB connect + migration +
  // session restore first. Those steps talk to AuraDB over the network and can
  // legitimately take 10-20+ seconds (cold start, retries in tryConnect()) —
  // holding the port closed for that whole window meant any client/dev-proxy
  // request arriving before then (e.g. Vite's /api and /ws proxy, or a browser
  // tab opened right after `npm run dev`) failed with ECONNREFUSED instead of
  // getting a normal response. DB-dependent routes already guard on
  // isDbAvailable() via requireDb and return a clean 503 in the meantime, so
  // there's no unguarded path that would misbehave with the DB not yet ready.
  server.listen(PORT, () => {
    log.info("server-listening", {
      component: "startup",
      port: PORT,
      msg: `Vibecode Heaven server running on http://localhost:${PORT}`,
    });

    // Check if the React frontend build exists
    const distIndex = path.join(__dirname, "../../frontend/dist/index.html");
    if (!fs.existsSync(distIndex)) {
      log.warn("frontend-dist-missing", {
        component: "startup",
        msg: "frontend/dist/index.html not found — serving legacy frontend/public/index.html as fallback. Run 'npm run build -w frontend' to build the React frontend.",
      });
    }
  });

  // Database connect + migration + session restore now run in the background,
  // after the port is already accepting connections.
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
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  log.info("shutdown", { component: "startup", msg: "Shutting down..." });

  await shutdownAllSessions();
  await plannerPool.shutdown();
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

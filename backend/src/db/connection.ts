import sql from "mssql";
import dotenv from "dotenv";
import { log } from "../logger.js";

dotenv.config();

// When DB_USER is empty (e.g. LocalDB with Windows auth), use NTLM trusted connection.
// Otherwise use standard SQL Server authentication (username/password).
const useWindowsAuth = !process.env.DB_USER;

const config: sql.config = {
  server: process.env.DB_SERVER || "localhost",
  database: process.env.DB_DATABASE || "TecFactory",
  port: parseInt(process.env.DB_PORT || "1433", 10),
  options: {
    encrypt: process.env.DB_ENCRYPT === "true",
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === "true",
  },
  connectionTimeout: 60000, // 60s — allows Azure SQL serverless to wake from pause
  requestTimeout: 30000,
  pool: {
    max: 10,
    // min: 0 — no idle connections kept alive. The pool grows from zero on demand
    // and fully releases connections when they go idle. This allows Azure SQL
    // serverless to actually auto-pause when no activity is happening.
    min: 0,
    idleTimeoutMillis: 30000,
  },
  // Auth: Windows (NTLM/trusted) when no user is provided, SQL auth otherwise
  ...(useWindowsAuth
    ? {
        authentication: {
          type: "ntlm",
          options: {
            domain: process.env.DB_DOMAIN || "",
            userName: process.env.DB_NTLM_USER || "",
            password: process.env.DB_NTLM_PASSWORD || "",
          },
        },
      }
    : {
        user: process.env.DB_USER || "sa",
        password: process.env.DB_PASSWORD || "",
      }),
};

let pool: sql.ConnectionPool | null = null;
let dbAvailable = false;

/** Returns true if the database connection is established and healthy. */
export function isDbAvailable(): boolean {
  return dbAvailable && pool !== null && pool.connected;
}

/**
 * Attempts to connect to the database with retries.
 * Returns the pool on success, or null on failure (without throwing).
 */
export async function tryConnect(
  retries = 2,
  delayMs = 5000
): Promise<sql.ConnectionPool | null> {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      if (pool) {
        // Previous pool object exists but may be disconnected — close it first
        try { await pool.close(); } catch { /* ignore */ }
        pool = null;
      }
      pool = await new sql.ConnectionPool(config).connect();
      dbAvailable = true;
      log.info("db-connected", {
        component: "db",
        server: config.server,
        database: config.database,
        msg: `Connected to ${config.server}/${config.database}`,
      });
      return pool;
    } catch (err: any) {
      const isLast = attempt === retries + 1;
      if (isLast) {
        dbAvailable = false;
        log.error("db-connect-failed", {
          component: "db",
          server: config.server,
          database: config.database,
          attempts: attempt,
          error: err?.message || String(err),
          msg: "Could not connect to database — DB-dependent features will be unavailable until it is reachable",
        });
        return null;
      }
      log.warn("db-connect-retry", {
        component: "db",
        attempt,
        retryInSeconds: delayMs / 1000,
        error: err?.message || String(err),
        msg: `Connection attempt ${attempt} failed, retrying in ${delayMs / 1000}s`,
      });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null;
}

/**
 * Returns the active connection pool.
 * Throws if the database is not available — callers should check isDbAvailable() first
 * or handle the error at the route/middleware level.
 */
export async function getPool(): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) {
    return pool;
  }

  // Attempt reconnection
  const connected = await tryConnect();
  if (!connected) {
    throw new Error("Database is not available");
  }
  return connected;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
    dbAvailable = false;
    log.info("db-pool-closed", { component: "db", msg: "Connection pool closed" });
  }
}

/**
 * Returns current connection pool statistics.
 * Used by the periodic pool metrics emitter for Azure Monitor observability.
 * Returns null if the pool is not connected.
 */
export function getPoolStats(): {
  poolSize: number;
  poolAvailable: number;
  poolPending: number;
  poolBorrowed: number;
} | null {
  if (!pool || !pool.connected) return null;

  // mssql uses tarn.js internally — pool.pool exposes the tarn Pool instance
  const tarnPool = (pool as any).pool;
  if (!tarnPool) return null;

  return {
    poolSize: tarnPool.numFree() + tarnPool.numUsed(),
    poolAvailable: tarnPool.numFree(),
    poolPending: tarnPool.numPendingAcquires(),
    poolBorrowed: tarnPool.numUsed(),
  };
}

export { sql };

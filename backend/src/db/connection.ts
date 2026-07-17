import sql from "mssql";
import dotenv from "dotenv";

dotenv.config();

const config: sql.config = {
  server: process.env.DB_SERVER || "localhost",
  database: process.env.DB_DATABASE || "TecFactory",
  user: process.env.DB_USER || "sa",
  password: process.env.DB_PASSWORD || "",
  port: parseInt(process.env.DB_PORT || "1433", 10),
  options: {
    encrypt: process.env.DB_ENCRYPT === "true",
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === "true",
  },
  pool: {
    max: 10,
    min: 2,
    idleTimeoutMillis: 30000,
  },
};

let pool: sql.ConnectionPool | null = null;
let dbAvailable = false;

/** Returns true if the database connection is established and healthy. */
export function isDbAvailable(): boolean {
  return dbAvailable && pool !== null && pool.connected;
}

/**
 * Attempts to connect to the database.
 * Returns the pool on success, or null on failure (without throwing).
 */
export async function tryConnect(): Promise<sql.ConnectionPool | null> {
  try {
    if (!pool) {
      pool = await new sql.ConnectionPool(config).connect();
    }
    dbAvailable = true;
    console.log(`[db] Connected to ${config.server}/${config.database}`);
    return pool;
  } catch (err: any) {
    dbAvailable = false;
    console.warn(
      `[db] ⚠ Could not connect to database (${config.server}/${config.database}): ${err.message || err}`
    );
    console.warn(
      "[db] ⚠ The server will continue running but database-dependent features will be unavailable."
    );
    return null;
  }
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
    console.log("[db] Connection pool closed");
  }
}

export { sql };

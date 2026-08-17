import neo4j, { Driver, ManagedTransaction, Session } from "neo4j-driver";
import dotenv from "dotenv";
import { log } from "../logger.js";

dotenv.config();

const NEO4J_URI = process.env.NEO4J_URI || "";
const NEO4J_USERNAME = process.env.NEO4J_USERNAME || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "";
// AuraDB Free provisions a single database whose name matches the instance ID
// (see backend/.env.example) — undefined lets the driver fall back to
// whatever the server reports as its default database.
const NEO4J_DATABASE = process.env.NEO4J_DATABASE || undefined;

let driver: Driver | null = null;
let dbAvailable = false;

/** Returns true if the database connection is established and healthy. */
export function isDbAvailable(): boolean {
  return dbAvailable && driver !== null;
}

/**
 * Attempts to connect to the database with retries.
 * Returns the driver on success, or null on failure (without throwing).
 *
 * Unlike the previous mssql pool, a neo4j-driver Driver is cheap to hold
 * onto and does not eagerly open a connection when constructed — actual
 * connectivity is only verified here via verifyConnectivity(). If that
 * fails, the same Driver instance is reused on retry (recreating it isn't
 * necessary and drivers are "reasonably expensive to create" per the
 * driver's own docs).
 */
export async function tryConnect(retries = 2, delayMs = 5000): Promise<Driver | null> {
  if (!NEO4J_URI) {
    dbAvailable = false;
    log.error("db-connect-failed", {
      component: "db",
      error: "NEO4J_URI is not set",
      msg: "Cannot connect — NEO4J_URI is missing from the environment (see backend/.env.example)",
    });
    return null;
  }

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      if (!driver) {
        driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD), {
          // Every ID in this app (task/tab/agent/session/user) is a plain JS
          // number from a simple incrementing counter (see id-counter.ts) —
          // it will never approach 2^53. Disabling lossless integers means
          // every property the driver returns is a normal `number`, matching
          // the plain-number convention already used throughout types.ts,
          // instead of every db/*.ts call site needing `.toNumber()`.
          disableLosslessIntegers: true,
          // Generous timeout — AuraDB Free auto-pauses after 72h of
          // inactivity and can take a while to resume on the next connection
          // attempt (mirrors the previous Azure SQL serverless comment here).
          connectionTimeout: 60000,
        });
      }
      await driver.verifyConnectivity(NEO4J_DATABASE ? { database: NEO4J_DATABASE } : undefined);
      dbAvailable = true;
      log.info("db-connected", {
        component: "db",
        uri: NEO4J_URI,
        database: NEO4J_DATABASE,
        msg: `Connected to ${NEO4J_URI}`,
      });
      return driver;
    } catch (err: any) {
      const isLast = attempt === retries + 1;
      if (isLast) {
        dbAvailable = false;
        log.error("db-connect-failed", {
          component: "db",
          uri: NEO4J_URI,
          database: NEO4J_DATABASE,
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
 * Returns the active driver.
 * Throws if the database is not available — callers should check isDbAvailable() first
 * or handle the error at the route/middleware level.
 */
export async function getDriver(): Promise<Driver> {
  if (driver && dbAvailable) {
    return driver;
  }

  const connected = await tryConnect();
  if (!connected) {
    throw new Error("Database is not available");
  }
  return connected;
}

export async function closePool(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
    dbAvailable = false;
    log.info("db-pool-closed", { component: "db", msg: "Driver closed" });
  }
}

/**
 * Runs `work` in a managed READ transaction (session.executeRead) — the
 * driver automatically retries on transient errors (e.g. deadlocks) with
 * exponential backoff. This is the standard primitive db/*.ts modules should
 * use for read queries; opens and closes its own session.
 */
export async function readQuery<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
  const d = await getDriver();
  const session: Session = d.session(NEO4J_DATABASE ? { database: NEO4J_DATABASE } : undefined);
  try {
    return await session.executeRead(work);
  } finally {
    await session.close();
  }
}

/**
 * Runs `work` in a managed WRITE transaction (session.executeWrite) — same
 * auto-retry behavior as readQuery. This is the standard primitive db/*.ts
 * modules should use for write queries; opens and closes its own session.
 *
 * For the task-claiming CAS loop (agent/task-claimer.ts), each candidate
 * attempt calls this once per candidate — i.e. each attempt is its own
 * managed write transaction, per the migration design.
 */
export async function writeQuery<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
  const d = await getDriver();
  const session: Session = d.session(NEO4J_DATABASE ? { database: NEO4J_DATABASE } : undefined);
  try {
    return await session.executeWrite(work);
  } finally {
    await session.close();
  }
}

/**
 * Runs a single schema statement (CREATE/DROP CONSTRAINT, CREATE/DROP INDEX)
 * as its own auto-commit session.run() call — NOT wrapped in an
 * executeWrite-managed transaction. Schema statements are not ordinary data
 * writes: empirically (verified against this app's own AuraDB instance),
 * running several CREATE CONSTRAINT statements back-to-back in quick
 * succession can trigger a transient schema-lock deadlock
 * (`ForsetiClient ... can't acquire EXCLUSIVE SCHEMA_NAME ...`). That error
 * is retryable by nature (no partial state to unwind — the statement either
 * didn't apply or fully applied), so this retries a few times with a short
 * backoff rather than failing the whole migration bootstrap on a transient
 * collision. Used only by migrate.ts — regular db/*.ts data queries should
 * use readQuery/writeQuery instead.
 */
export async function runSchemaStatement(statement: string, maxAttempts = 3): Promise<void> {
  const d = await getDriver();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const session: Session = d.session(NEO4J_DATABASE ? { database: NEO4J_DATABASE } : undefined);
    try {
      await session.run(statement);
      return;
    } catch (err) {
      const retryable = err instanceof neo4j.Neo4jError && err.retryable;
      if (!retryable || attempt === maxAttempts) throw err;
      log.warn("db-schema-statement-retry", {
        component: "db",
        attempt,
        statement,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, 500 * attempt));
    } finally {
      await session.close();
    }
  }
}

export { neo4j };

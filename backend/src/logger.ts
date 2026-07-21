/**
 * Structured Logger — Emits JSON lines to stdout for Azure Monitor / Log Analytics.
 *
 * Azure Container Apps captures stdout/stderr and forwards to Log Analytics
 * as `ContainerAppConsoleLogs_CL`. By emitting structured JSON, the workbook
 * queries can use `parse_json(Log_s)` to extract fields like event, sessionId, etc.
 *
 * This logger is used for observability-relevant events (session lifecycle, errors,
 * worker spawns, pool metrics). Regular debug/info logs continue using console.log.
 */

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

/**
 * Emit a structured JSON log line to stdout.
 * Fields are merged into a flat JSON object for easy KQL parsing.
 */
export function structuredLog(
  level: LogLevel,
  event: string,
  data?: Record<string, unknown>
): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

// ─── Convenience wrappers ────────────────────────────────────────────────────

/** Log a session lifecycle event (start, stop, crash, error, retry). */
export function logSessionEvent(
  event: "session-created" | "session-started" | "session-stopped" | "session-error" | "session-deleted" | "session-retry",
  sessionId: string,
  data?: Record<string, unknown>
): void {
  structuredLog("info", event, { sessionId, ...data });
}

/** Log a worker lifecycle event (spawn, exit, crash). */
export function logWorkerEvent(
  event: "worker-spawned" | "worker-exited" | "worker-crashed" | "worker-connected",
  sessionId: string,
  data?: Record<string, unknown>
): void {
  const level: LogLevel = event === "worker-crashed" ? "error" : "info";
  structuredLog(level, event, { sessionId, ...data });
}

/** Log database pool metrics (periodic snapshot). */
export function logPoolMetrics(metrics: {
  poolSize: number;
  poolAvailable: number;
  poolPending: number;
  poolBorrowed: number;
}): void {
  structuredLog("info", "db-pool", metrics);
}

/** Log an API error (5xx). */
export function logApiError(
  statusCode: number,
  method: string,
  path: string,
  message: string
): void {
  structuredLog("error", "api-error", {
    statusCode,
    method,
    path,
    message,
  });
}

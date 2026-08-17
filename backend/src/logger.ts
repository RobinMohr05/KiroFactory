/**
 * Structured Logger — Emits JSON lines to stdout for Azure Monitor / Log Analytics.
 *
 * Azure Container Apps captures stdout/stderr and forwards to Log Analytics
 * as `ContainerAppConsoleLogs_CL`. By emitting structured JSON, the workbook
 * queries can use `parse_json(Log_s)` to extract fields like event, sessionId, etc.
 *
 * Every log line shares a common shape:
 *   { ts, level, event, component?, msg?, ...context }
 *
 * - `event` is a stable, machine-greppable identifier (e.g. "worker-spawned").
 * - `component` groups events by subsystem (e.g. "db", "session-manager").
 * - `msg` is an optional human-readable sentence for quick scanning.
 * - Any remaining fields carry structured context for KQL queries.
 *
 * Prefer the leveled `log.*` helpers and the domain wrappers below over raw
 * console.* so logs stay consistent and queryable. Guidance:
 *   - info : notable lifecycle events worth seeing in normal operation.
 *   - warn : recoverable problems / degraded state that may need attention.
 *   - error: failures that broke a user-visible operation.
 *   - debug: high-volume detail, off by default (LOG_LEVEL=debug to enable).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Minimum level to emit. Anything below this is dropped so we don't spam the
 * log pipeline. Controlled by LOG_LEVEL (defaults to "info").
 */
const MIN_LEVEL: LogLevel = (() => {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env === "debug" || env === "info" || env === "warn" || env === "error") {
    return env;
  }
  return "info";
})();

/**
 * Emit a structured JSON log line to stdout (stderr for errors).
 * Fields are merged into a flat JSON object for easy KQL parsing.
 */
export function structuredLog(
  level: LogLevel,
  event: string,
  data?: Record<string, unknown>
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[MIN_LEVEL]) return;

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };

  const line = JSON.stringify(entry) + "\n";
  // Route errors/warnings to stderr so they're distinguishable in Log Analytics.
  if (level === "error" || level === "warn") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

/**
 * Leveled logging helpers. Pass a stable `event` and structured context.
 *
 * Example:
 *   log.info("server-listening", { component: "startup", port, msg: `Listening on :${port}` });
 */
export const log = {
  debug(event: string, data?: Record<string, unknown>): void {
    structuredLog("debug", event, data);
  },
  info(event: string, data?: Record<string, unknown>): void {
    structuredLog("info", event, data);
  },
  warn(event: string, data?: Record<string, unknown>): void {
    structuredLog("warn", event, data);
  },
  error(event: string, data?: Record<string, unknown>): void {
    structuredLog("error", event, data);
  },
};

/**
 * Normalize an unknown thrown value into structured error fields.
 * Use when logging inside a catch block so both the message and stack are captured.
 *
 * Example:
 *   catch (err) { log.error("route-error", { component: "agents", ...toErrorFields(err) }); }
 */
export function toErrorFields(err: unknown): { error: string; stack?: string } {
  if (err instanceof Error) {
    return { error: err.message, stack: err.stack };
  }
  return { error: String(err) };
}

// ─── Convenience wrappers ────────────────────────────────────────────────────

/** Log a session lifecycle event (start, stop, crash, error, retry). */
export function logSessionEvent(
  event: "session-created" | "session-started" | "session-stopped" | "session-error" | "session-deleted" | "session-retry" | "session-tabs-updated" | "session-pin-changed" | "session-reordered" | "session-fields-updated",
  sessionId: number,
  data?: Record<string, unknown>
): void {
  const level: LogLevel = event === "session-error" ? "error" : "info";
  structuredLog(level, event, { component: "session-manager", sessionId, ...data });
}

/** Log a worker lifecycle event (spawn, connect, exit, crash, prompt turn). */
export function logWorkerEvent(
  event:
    | "worker-spawned"
    | "worker-exited"
    | "worker-crashed"
    | "worker-connected"
    | "worker-prompt-done"
    | "worker-prompt-failed",
  sessionId: number,
  data?: Record<string, unknown>
): void {
  const level: LogLevel =
    event === "worker-crashed" || event === "worker-prompt-failed" ? "error" : "info";
  structuredLog(level, event, { component: "worker", sessionId, ...data });
}

/** Log an API error (5xx). */
export function logApiError(
  statusCode: number,
  method: string,
  path: string,
  message: string,
  extra?: Record<string, unknown>
): void {
  structuredLog("error", "api-error", {
    component: "http",
    statusCode,
    method,
    path,
    message,
    ...extra,
  });
}

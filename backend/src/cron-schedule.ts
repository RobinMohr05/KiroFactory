/**
 * Cron schedule helpers — thin wrappers around `cron-parser` used by the
 * scheduled-session feature (see scheduled-session-manager.ts and the session
 * routes). Kept as a standalone module so cron validation and next-fire-time
 * math can be unit-tested independently of the scheduler's timers.
 */

import { CronExpressionParser } from "cron-parser";

/**
 * True if `expr` is a valid cron expression parseable by cron-parser.
 * Non-string / empty input is invalid.
 */
export function isValidCronExpression(expr: string): boolean {
  if (typeof expr !== "string" || expr.trim().length === 0) return false;
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * True if `tz` is a valid IANA timezone name (validated via the runtime's
 * own Intl database — the same source cron-parser resolves against).
 * Non-string / empty input is invalid.
 */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== "string" || tz.trim().length === 0) return false;
  try {
    // Throws RangeError for an unknown timezone.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the delay in milliseconds from `from` (default: now) until the next
 * time `expr` fires, evaluated in timezone `tz`. Never returns a negative
 * value. Throws if `expr` is not a valid cron expression.
 */
export function computeNextFireDelayMs(
  expr: string,
  tz: string,
  from: Date = new Date()
): number {
  const interval = CronExpressionParser.parse(expr, {
    tz: tz || "UTC",
    currentDate: from,
  });
  const next = interval.next().toDate();
  return Math.max(0, next.getTime() - from.getTime());
}

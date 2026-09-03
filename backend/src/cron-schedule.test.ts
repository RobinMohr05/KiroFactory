/**
 * Tests for cron-schedule.ts — validation of cron expressions and IANA
 * timezones, plus next-fire-time computation in a given timezone.
 */

import { describe, it, expect } from "vitest";
import {
  isValidCronExpression,
  isValidTimezone,
  computeNextFireDelayMs,
} from "./cron-schedule.js";

describe("isValidCronExpression", () => {
  it("accepts a standard 5-field cron expression", () => {
    expect(isValidCronExpression("0 9 * * *")).toBe(true);
  });

  it("accepts every-minute", () => {
    expect(isValidCronExpression("* * * * *")).toBe(true);
  });

  it("rejects nonsense", () => {
    expect(isValidCronExpression("not a cron")).toBe(false);
  });

  it("rejects an out-of-range field", () => {
    expect(isValidCronExpression("99 99 * * *")).toBe(false);
  });

  it("rejects empty / non-string input", () => {
    expect(isValidCronExpression("")).toBe(false);
    expect(isValidCronExpression(undefined as unknown as string)).toBe(false);
    expect(isValidCronExpression(null as unknown as string)).toBe(false);
  });
});

describe("isValidTimezone", () => {
  it("accepts a valid IANA timezone", () => {
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
  });

  it("rejects an invalid timezone", () => {
    expect(isValidTimezone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimezone("Not/AZone")).toBe(false);
  });

  it("rejects empty / non-string input", () => {
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone(undefined as unknown as string)).toBe(false);
  });
});

describe("computeNextFireDelayMs", () => {
  it("returns a positive delay for a future fire time", () => {
    // Every minute — next fire is always within 60s
    const delay = computeNextFireDelayMs("* * * * *", "UTC", new Date("2026-01-01T00:00:00Z"));
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(60_000);
  });

  it("computes the delay in the session's timezone", () => {
    // "0 9 * * *" = 09:00 local. From 08:00 UTC on 2026-01-01:
    //  - In UTC, next fire is 09:00 UTC → 1 hour = 3_600_000 ms.
    //  - In America/New_York (UTC-5 in Jan), 09:00 local = 14:00 UTC → 6 hours.
    const from = new Date("2026-01-01T08:00:00Z");
    const utcDelay = computeNextFireDelayMs("0 9 * * *", "UTC", from);
    const nyDelay = computeNextFireDelayMs("0 9 * * *", "America/New_York", from);
    expect(utcDelay).toBe(3_600_000);
    expect(nyDelay).toBe(6 * 3_600_000);
  });

  it("throws on an invalid cron expression", () => {
    expect(() => computeNextFireDelayMs("bogus", "UTC")).toThrow();
  });
});

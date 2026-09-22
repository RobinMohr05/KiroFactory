/**
 * Tests for the per-account login lockout tracker (OWASP A07 — Identification
 * and Authentication Failures; coding_guidelines.MD §2, "Account lockout after
 * repeated failures").
 *
 * IP-based rate limiting (see rate-limit.test.ts) blunts brute-force from a
 * single source, but a distributed attack (many IPs, one target account) slips
 * past it. This tracker locks a specific account after N consecutive failed
 * login attempts, regardless of source IP, and unlocks it after a cooldown or
 * on the next successful login.
 *
 * The tracker is deliberately in-memory (no DB schema change): a lockout is a
 * short-lived, best-effort defensive measure, and a process restart clearing it
 * is acceptable.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  recordFailedLogin,
  clearFailedLogins,
  isAccountLockedOut,
  __resetLockoutState,
} from "../account-lockout.js";

const EMAIL = "victim@example.com";

describe("Account lockout tracker", () => {
  beforeEach(() => {
    __resetLockoutState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not lock out an account below the failure threshold", () => {
    const opts = { maxAttempts: 5, lockoutMs: 60_000 };
    for (let i = 0; i < 4; i++) {
      recordFailedLogin(EMAIL, opts);
    }
    expect(isAccountLockedOut(EMAIL, opts)).toBe(false);
  });

  it("locks out an account once the failure threshold is reached", () => {
    const opts = { maxAttempts: 5, lockoutMs: 60_000 };
    for (let i = 0; i < 5; i++) {
      recordFailedLogin(EMAIL, opts);
    }
    expect(isAccountLockedOut(EMAIL, opts)).toBe(true);
  });

  it("clears the failure count on a successful login", () => {
    const opts = { maxAttempts: 5, lockoutMs: 60_000 };
    for (let i = 0; i < 4; i++) {
      recordFailedLogin(EMAIL, opts);
    }
    clearFailedLogins(EMAIL);
    // After clearing, one more failure must not immediately re-lock.
    recordFailedLogin(EMAIL, opts);
    expect(isAccountLockedOut(EMAIL, opts)).toBe(false);
  });

  it("releases the lockout after the cooldown window elapses", () => {
    vi.useFakeTimers();
    const opts = { maxAttempts: 3, lockoutMs: 60_000 };
    for (let i = 0; i < 3; i++) {
      recordFailedLogin(EMAIL, opts);
    }
    expect(isAccountLockedOut(EMAIL, opts)).toBe(true);

    // Advance past the cooldown window.
    vi.advanceTimersByTime(60_001);
    expect(isAccountLockedOut(EMAIL, opts)).toBe(false);
  });

  it("tracks accounts independently", () => {
    const opts = { maxAttempts: 3, lockoutMs: 60_000 };
    for (let i = 0; i < 3; i++) {
      recordFailedLogin("a@example.com", opts);
    }
    expect(isAccountLockedOut("a@example.com", opts)).toBe(true);
    expect(isAccountLockedOut("b@example.com", opts)).toBe(false);
  });

  it("normalizes email case so lockout can't be bypassed by casing", () => {
    const opts = { maxAttempts: 3, lockoutMs: 60_000 };
    for (let i = 0; i < 3; i++) {
      recordFailedLogin("Victim@Example.com", opts);
    }
    expect(isAccountLockedOut("victim@example.com", opts)).toBe(true);
  });
});

/**
 * Per-account login lockout tracker (OWASP A07 — Identification and
 * Authentication Failures; coding_guidelines.MD §2, "Account lockout after
 * repeated failures").
 *
 * IP-based rate limiting (see middleware/rate-limit.ts) blunts brute-force from
 * a single source, but a distributed attack (many source IPs, one target
 * account) slips past it. This tracker complements that by locking a *specific
 * account* after N consecutive failed login attempts, regardless of source IP,
 * releasing it after a cooldown window or on the next successful login.
 *
 * State is intentionally in-memory: a lockout is a short-lived, best-effort
 * defensive measure, so a process restart clearing it is acceptable and avoids
 * a DB schema change. In the multi-replica ACA deployment each replica tracks
 * independently, which only weakens (never tightens) the guarantee — acceptable
 * for a defense-in-depth layer sitting behind the per-IP limiter.
 */

export interface LockoutOptions {
  /** Consecutive failures that trigger a lockout. */
  maxAttempts: number;
  /** How long an account stays locked after the threshold is hit, in ms. */
  lockoutMs: number;
}

/** Default policy: lock for 15 minutes after 5 consecutive failed logins. */
export const DEFAULT_LOCKOUT_OPTIONS: LockoutOptions = {
  maxAttempts: 5,
  lockoutMs: 15 * 60 * 1000,
};

interface Entry {
  failures: number;
  /** Epoch ms of the most recent recorded failure. */
  lastFailureAt: number;
}

const entries = new Map<string, Entry>();

/** Normalizes an email key so casing/whitespace can't be used to dodge lockout. */
function keyFor(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Records a failed login attempt for the given account and returns true if the
 * account is now locked out as a result.
 */
export function recordFailedLogin(email: string, opts: LockoutOptions = DEFAULT_LOCKOUT_OPTIONS): boolean {
  const key = keyFor(email);
  const now = Date.now();
  const existing = entries.get(key);

  // If a prior lockout window has already elapsed, start counting fresh. The
  // stale entry is overwritten below, so it never lingers past its window here.
  if (existing && now - existing.lastFailureAt > opts.lockoutMs) {
    entries.set(key, { failures: 1, lastFailureAt: now });
    return false;
  }

  const failures = (existing?.failures ?? 0) + 1;
  entries.set(key, { failures, lastFailureAt: now });
  return failures >= opts.maxAttempts;
}

/**
 * Clears the failure count for an account. Call on a successful login (or after
 * an admin/manual reset) so legitimate users aren't penalized for past typos.
 */
export function clearFailedLogins(email: string): void {
  entries.delete(keyFor(email));
}

/**
 * Returns true if the account is currently locked out — i.e. it has reached the
 * failure threshold and the cooldown window has not yet elapsed.
 */
export function isAccountLockedOut(email: string, opts: LockoutOptions = DEFAULT_LOCKOUT_OPTIONS): boolean {
  const key = keyFor(email);
  const entry = entries.get(key);
  if (!entry) return false;
  // The entry's window has fully elapsed: it's logically dead, so evict it on
  // read to keep the Map bounded even for emails that only ever fail.
  if (Date.now() - entry.lastFailureAt > opts.lockoutMs) {
    entries.delete(key);
    return false;
  }
  if (entry.failures < opts.maxAttempts) return false;
  // Threshold reached — locked until the cooldown elapses from the last failure.
  return true;
}

/**
 * Deletes every entry whose most recent failure is older than the lockout
 * window — such an entry is logically dead (see recordFailedLogin's reset
 * branch) and only kept around waiting to be reclaimed. Called on a timer (see
 * below) and exposed for tests.
 */
function sweepExpiredLockouts(opts: LockoutOptions = DEFAULT_LOCKOUT_OPTIONS): void {
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (now - entry.lastFailureAt > opts.lockoutMs) {
      entries.delete(key);
    }
  }
}

/**
 * Periodic reaper that bounds Map growth from a distributed credential-stuffing
 * sweep across many distinct (possibly non-existent) emails, which would
 * otherwise accumulate an entry per email for the process lifetime.
 *
 * The interval is unref()'d so it never keeps the Node process alive on its own
 * — this remains a best-effort, in-memory measure (see the file header).
 */
const SWEEP_INTERVAL_MS = DEFAULT_LOCKOUT_OPTIONS.lockoutMs;
const sweepTimer = setInterval(() => sweepExpiredLockouts(), SWEEP_INTERVAL_MS);
sweepTimer.unref?.();

/**
 * Test-only: wipes all lockout state. Not part of the production API surface.
 */
export function __resetLockoutState(): void {
  entries.clear();
}

/**
 * Test-only: number of tracked entries, for asserting the Map stays bounded.
 */
export function __lockoutEntryCount(): number {
  return entries.size;
}

/**
 * Test-only: run the reaper synchronously (the production sweep fires on an
 * unref()'d interval, which isn't deterministic under fake timers).
 */
export function __sweepExpiredLockouts(opts: LockoutOptions = DEFAULT_LOCKOUT_OPTIONS): void {
  sweepExpiredLockouts(opts);
}

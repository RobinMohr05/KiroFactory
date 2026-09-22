import type { RequestHandler } from "express";
import rateLimit from "express-rate-limit";

/**
 * Rate-limiting middleware (OWASP A07 — Identification and Authentication
 * Failures; coding_guidelines.MD §2, which explicitly requires "rate limiting
 * on auth endpoints (express-rate-limit)" and general API rate limiting).
 *
 * The backend previously had NO throttling on any route. The public,
 * unauthenticated endpoints — `/api/auth/login`, `/api/auth/register`, and the
 * `/api/webhooks/tasks` webhook — could be brute-forced or hammered without
 * limit. These factories build the limiters index.ts wires up:
 *
 *   - a STRICT limiter for the auth/webhook endpoints (few attempts/minute), and
 *   - a LOOSER GLOBAL limiter for all of `/api/*` to blunt general abuse.
 *
 * Both return `429 Too Many Requests` with a `Retry-After` header (the
 * `standardHeaders` option also emits the `RateLimit-*` headers) once a client
 * exceeds its per-IP budget within the window.
 *
 * Exposing the limits/window as parameters (rather than hard-coding them inside
 * the middleware) keeps the limiters unit-testable — tests build a limiter with
 * a tiny `max` and assert the 200→429 transition without waiting on a real
 * 15-minute window.
 */

/** Default strict window/limit for auth + webhook endpoints. */
const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const AUTH_MAX = 10; // 10 attempts per IP per window (guidelines: 5–10/min band, conservative here)

/** Default looser window/limit for the global /api/* guard. */
const GLOBAL_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const GLOBAL_MAX = 1000; // generous ceiling — only blunts abusive floods, not normal use

export interface RateLimiterOptions {
  /** Time window in milliseconds. */
  windowMs?: number;
  /** Max requests allowed per client IP within the window. */
  max?: number;
}

/**
 * Standard message body returned on a 429. Shape mirrors the JSON error
 * responses the rest of the API returns (`{ error: string }`).
 */
const TOO_MANY_REQUESTS = { error: "Too many requests, please try again later." };

/**
 * Strict limiter for authentication + webhook endpoints. Mount this directly on
 * `POST /api/auth/login`, `POST /api/auth/register`, and `POST /api/webhooks/tasks`.
 */
export function createAuthRateLimiter(opts: RateLimiterOptions = {}): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs ?? AUTH_WINDOW_MS,
    max: opts.max ?? AUTH_MAX,
    standardHeaders: true, // emit RateLimit-* and Retry-After headers
    legacyHeaders: false, // drop deprecated X-RateLimit-* headers
    message: TOO_MANY_REQUESTS,
  });
}

/**
 * Looser limiter for the whole `/api/*` surface, to blunt general flooding
 * without interfering with legitimate interactive use.
 */
export function createGlobalRateLimiter(opts: RateLimiterOptions = {}): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs ?? GLOBAL_WINDOW_MS,
    max: opts.max ?? GLOBAL_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: TOO_MANY_REQUESTS,
  });
}

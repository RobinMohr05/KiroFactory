/**
 * Centralized runtime configuration and secret validation.
 *
 * Historically the JWT signing/verification secret was read independently in
 * three places (routes/auth.ts, middleware/auth.ts, websocket-handler.ts), each
 * falling back to the SAME hardcoded literal when JWT_SECRET was unset. Since
 * that literal is committed to the repo, a deployment with a missing/empty
 * JWT_SECRET would silently sign and verify session tokens with a public
 * secret — letting anyone forge a `kf_session` cookie / Bearer token for any
 * user (a critical auth bypass across both REST and WebSocket auth).
 *
 * This module makes secret handling fail-fast and single-sourced: in production
 * a missing/empty JWT_SECRET throws at startup (see validateStartupSecrets(),
 * called from index.ts) instead of falling back. Outside production a fixed dev
 * fallback is allowed so local development and the test suite work without extra
 * setup — mirroring how NODE_ENV already gates other prod-only behavior here.
 */

/** Fallback secret used ONLY outside production (dev/test convenience). */
const DEV_JWT_SECRET = "vibecode-heaven-dev-secret-change-in-production";

type SecretEnv = {
  JWT_SECRET?: string;
  NODE_ENV?: string;
};

/**
 * Resolves the JWT secret from the given environment.
 *
 * - Returns JWT_SECRET when it is set to a non-empty value.
 * - Throws when running in production and JWT_SECRET is unset/empty/whitespace,
 *   so the process fails fast rather than silently using a public literal.
 * - Falls back to a dev-only secret outside production.
 *
 * Pure/environment-injectable so it can be unit-tested without mutating
 * process.env.
 */
export function resolveJwtSecret(env: SecretEnv = process.env): string {
  const configured = env.JWT_SECRET?.trim();
  if (configured) {
    return env.JWT_SECRET as string;
  }

  if (env.NODE_ENV === "production") {
    throw new Error(
      "JWT_SECRET environment variable is required in production. " +
        "Refusing to start with the hardcoded dev fallback, which would allow session forgery."
    );
  }

  return DEV_JWT_SECRET;
}

/**
 * The validated JWT secret for the running process. All auth code paths
 * (REST sign/verify and WebSocket verify) MUST import this rather than
 * re-reading process.env with their own literal fallback.
 */
export const JWT_SECRET = resolveJwtSecret();

/**
 * Validate required secrets at startup, failing fast on misconfiguration.
 * Call this early in index.ts so a production deployment with a missing
 * JWT_SECRET refuses to boot instead of running with a forgeable secret.
 */
export function validateStartupSecrets(): void {
  // Re-resolve against the current environment; throws in production if unset.
  resolveJwtSecret();
}

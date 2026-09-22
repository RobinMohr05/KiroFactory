/**
 * Shared application config — validated secrets and environment values.
 *
 * All secret-bearing env vars that are required for security-critical
 * operations are read through functions here, never with inline fallbacks.
 * This mirrors the pattern already used for ENCRYPTION_KEY in crypto.ts:
 * both secrets must be explicitly provided; hardcoded fallbacks are not
 * acceptable because they are committed to the repo and therefore public
 * knowledge.
 *
 * Each function reads `process.env` at call time so that tests can control
 * the env var value without needing to reload the module.
 */

/**
 * Returns the JWT signing/verification secret.
 *
 * Throws if `JWT_SECRET` is unset or empty — failing fast here is
 * intentional. An absent secret would otherwise cause all three JWT
 * consumers (routes/auth.ts, middleware/auth.ts, websocket-handler.ts) to
 * fall back to a hardcoded literal that is committed to the repo and
 * therefore usable by anyone to forge arbitrary session tokens.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "JWT_SECRET environment variable is required for JWT signing and verification"
    );
  }
  return secret;
}

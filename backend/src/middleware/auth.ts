import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { AuthenticatedRequest } from "../types.js";

const JWT_SECRET = process.env.JWT_SECRET || "kirofactory-dev-secret-change-in-production";
const COOKIE_NAME = "kf_session";

/**
 * Routes that are exempt from authentication.
 * These paths are relative to /api (e.g., "/auth/login" matches /api/auth/login).
 */
const PUBLIC_PATHS = [
  "/auth/login",
  "/auth/register",
  "/auth/settings",
  "/health",
];

/**
 * Extracts the JWT token from the request.
 * Checks the session cookie first, then falls back to Authorization: Bearer header.
 */
function extractToken(req: Request): string | null {
  // Try cookie first
  const cookieToken = req.cookies?.[COOKIE_NAME];
  if (cookieToken) return cookieToken;

  // Fall back to Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  return null;
}

/**
 * Express middleware that validates the JWT session token on every /api/* request,
 * except for explicitly exempted public paths (login, register, health).
 *
 * On success, attaches `userId` to the request object.
 * On failure, returns 401 with an appropriate error message.
 *
 * Token lifetime: 30 days (configured at sign time in routes/auth.ts).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: number };

    if (!payload.userId || typeof payload.userId !== "number") {
      res.status(401).json({ error: "Invalid token payload" });
      return;
    }

    // Attach userId to request object
    (req as Request & AuthenticatedRequest).userId = payload.userId;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: "Token expired" });
      return;
    }
    if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    res.status(401).json({ error: "Authentication failed" });
  }
}

/**
 * Returns true if the request path is a public (unauthenticated) API route.
 * Used by the global auth guard in index.ts to skip auth for specific paths.
 */
export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((publicPath) => path === publicPath || path.startsWith(publicPath + "/"));
}

/**
 * Helper to extract the authenticated userId from a request.
 * Must be used after requireAuth middleware.
 */
export function getUserId(req: Request): number {
  return (req as Request & AuthenticatedRequest).userId;
}

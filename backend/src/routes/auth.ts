import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { createUser, verifyPassword, verifyPasswordById, getUserById, getUserByEmail, updateUserPassword, updateUserKiroApiKey, updateUserDefaultGitProvider, deleteUser } from "../db/users.js";
import { isRegistrationEnabled } from "../db/settings.js";
import { createSession } from "../session-manager.js";
import { getUserId } from "../middleware/auth.js";
import type { CreateUserInput, AuthenticatedRequest, GitProvider } from "../types.js";
import { GIT_PROVIDERS, isGitProvider } from "../types.js";
import { log, toErrorFields } from "../logger.js";

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || "vibecode-heaven-dev-secret-change-in-production";
const JWT_EXPIRES_IN = "30d"; // 30-day long-lived token
const COOKIE_NAME = "kf_session";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

/**
 * Signs a JWT with the user's ID.
 */
function signToken(userId: number): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Sets the session cookie on the response.
 */
function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE_MS,
    path: "/",
  });
}

/**
 * Extracts the JWT token from request (cookie first, then Authorization header).
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

// GET /api/auth/settings — public endpoint for login page to check registration status
router.get("/settings", async (_req: Request, res: Response) => {
  try {
    const regEnabled = await isRegistrationEnabled();
    res.json({ registrationEnabled: regEnabled });
  } catch (err) {
    log.warn("route-degraded", {
      component: "auth",
      method: "GET",
      path: "/api/auth/settings",
      ...toErrorFields(err),
      msg: "Failed to read registration settings; defaulting to disabled",
    });
    res.json({ registrationEnabled: false });
  }
});

// POST /api/auth/register — create a new user account
router.post("/register", async (req: Request, res: Response) => {
  try {
    const { email, password, kiroApiKey } = req.body as {
      email?: string;
      password?: string;
      kiroApiKey?: string;
    };

    // Check if registration is enabled
    const regEnabled = await isRegistrationEnabled();
    if (!regEnabled) {
      res.status(403).json({ error: "Registration is currently disabled" });
      return;
    }

    // Validate required fields
    if (!email || !password || !kiroApiKey) {
      res.status(400).json({ error: "email, password, and kiroApiKey are required" });
      return;
    }

    // Validate email format (basic check)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      res.status(400).json({ error: "Invalid email format" });
      return;
    }

    // Validate password length
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    // Check if email is already taken
    const existing = await getUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: "A user with this email already exists" });
      return;
    }

    // Create user (bcrypt hash + AES-256 encryption handled in db/users.ts)
    const input: CreateUserInput = { email, password, kiroApiKey };
    const user = await createUser(input);

    // Every user gets one permanent, agentless "Chat" session, pinned first
    // in the sidebar. Non-fatal if it fails — the migration backfill will
    // catch it on the next server restart.
    try {
      createSession({ name: "Chat", userId: user.id, pinned: true });
    } catch (err) {
      log.warn("pinned-chat-session-create-failed", {
        component: "auth",
        userId: user.id,
        ...toErrorFields(err),
        msg: "Failed to create pinned Chat session for new user",
      });
    }

    // Issue session token
    const token = signToken(user.id);
    setSessionCookie(res, token);

    res.status(201).json({ user, token });
  } catch (err) {
    log.error("route-error", {
      component: "auth",
      method: "POST",
      path: "/api/auth/register",
      ...toErrorFields(err),
      msg: "Failed to register user",
    });
    res.status(500).json({ error: "Failed to register user" });
  }
});

// POST /api/auth/login — authenticate and issue session
router.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as {
      email?: string;
      password?: string;
    };

    if (!email || !password) {
      res.status(400).json({ error: "email and password are required" });
      return;
    }

    // Verify credentials
    const user = await verifyPassword(email, password);
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    // Issue session token
    const token = signToken(user.id);
    setSessionCookie(res, token);

    res.json({ user, token });
  } catch (err) {
    log.error("route-error", {
      component: "auth",
      method: "POST",
      path: "/api/auth/login",
      ...toErrorFields(err),
      msg: "Failed to login",
    });
    res.status(500).json({ error: "Failed to login" });
  }
});

// POST /api/auth/logout — invalidate session (clear cookie)
router.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
  res.json({ message: "Logged out successfully" });
});

// GET /api/auth/me — return current user profile
router.get("/me", async (req: Request, res: Response) => {
  try {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    let payload: { userId: number };
    try {
      payload = jwt.verify(token, JWT_SECRET) as { userId: number };
    } catch {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    const user = await getUserById(payload.userId);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    res.json({ user });
  } catch (err) {
    log.error("route-error", {
      component: "auth",
      method: "GET",
      path: "/api/auth/me",
      ...toErrorFields(err),
      msg: "Failed to fetch user profile",
    });
    res.status(500).json({ error: "Failed to fetch user profile" });
  }
});

// PUT /api/auth/me/password — change password (requires current password)
router.put("/me/password", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };

    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: "currentPassword and newPassword are required" });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ error: "New password must be at least 8 characters" });
      return;
    }

    // Verify current password
    const valid = await verifyPasswordById(userId, currentPassword);
    if (!valid) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    // Update password
    const user = await updateUserPassword(userId, newPassword);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ message: "Password updated successfully", user });
  } catch (err) {
    log.error("route-error", {
      component: "auth",
      method: "PUT",
      path: "/api/auth/me/password",
      ...toErrorFields(err),
      msg: "Failed to update password",
    });
    res.status(500).json({ error: "Failed to update password" });
  }
});

// PUT /api/auth/me/api-key — update Kiro API key (requires current password)
router.put("/me/api-key", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { currentPassword, kiroApiKey } = req.body as {
      currentPassword?: string;
      kiroApiKey?: string;
    };

    if (!currentPassword || !kiroApiKey) {
      res.status(400).json({ error: "currentPassword and kiroApiKey are required" });
      return;
    }

    // Verify current password
    const valid = await verifyPasswordById(userId, currentPassword);
    if (!valid) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    // Update API key
    const user = await updateUserKiroApiKey(userId, kiroApiKey);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ message: "Kiro API key updated successfully", user });
  } catch (err) {
    log.error("route-error", {
      component: "auth",
      method: "PUT",
      path: "/api/auth/me/api-key",
      ...toErrorFields(err),
      msg: "Failed to update API key",
    });
    res.status(500).json({ error: "Failed to update API key" });
  }
});

// PUT /api/auth/me/default-git-provider — set the profile-level default provider
router.put("/me/default-git-provider", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { defaultGitProvider } = req.body as { defaultGitProvider?: string | null };

    // null / "" / "auto" all mean "no default — detect from the repository URL"
    let provider: GitProvider | null = null;
    if (
      defaultGitProvider !== undefined &&
      defaultGitProvider !== null &&
      defaultGitProvider !== "" &&
      defaultGitProvider !== "auto"
    ) {
      if (!isGitProvider(defaultGitProvider)) {
        res.status(400).json({
          error: `defaultGitProvider must be one of: ${GIT_PROVIDERS.join(", ")}, or null`,
        });
        return;
      }
      provider = defaultGitProvider;
    }

    const user = await updateUserDefaultGitProvider(userId, provider);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ message: "Default git provider updated", user });
  } catch (err) {
    log.error("route-error", {
      component: "auth",
      method: "PUT",
      path: "/api/auth/me/default-git-provider",
      ...toErrorFields(err),
      msg: "Failed to update default git provider",
    });
    res.status(500).json({ error: "Failed to update default git provider" });
  }
});

// DELETE /api/auth/me — delete own account (requires password confirmation)
router.delete("/me", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { password } = req.body as { password?: string };

    if (!password) {
      res.status(400).json({ error: "password is required to confirm account deletion" });
      return;
    }

    // Verify password
    const valid = await verifyPasswordById(userId, password);
    if (!valid) {
      res.status(401).json({ error: "Password is incorrect" });
      return;
    }

    // Delete the user (cascading deletes will clean up related data)
    const deleted = await deleteUser(userId);
    if (!deleted) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Clear session cookie
    res.clearCookie(COOKIE_NAME, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });

    res.json({ message: "Account deleted successfully" });
  } catch (err) {
    log.error("route-error", {
      component: "auth",
      method: "DELETE",
      path: "/api/auth/me",
      ...toErrorFields(err),
      msg: "Failed to delete account",
    });
    res.status(500).json({ error: "Failed to delete account" });
  }
});

export default router;

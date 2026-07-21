import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { createUser, verifyPassword, verifyPasswordById, getUserById, getUserByEmail, updateUserPassword, updateUserKiroApiKey } from "../db/users.js";
import { isRegistrationEnabled } from "../db/settings.js";
import { getUserId } from "../middleware/auth.js";
import type { CreateUserInput, AuthenticatedRequest } from "../types.js";

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || "kirofactory-dev-secret-change-in-production";
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
    console.error("GET /api/auth/settings error:", err);
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

    // Issue session token
    const token = signToken(user.id);
    setSessionCookie(res, token);

    res.status(201).json({ user, token });
  } catch (err) {
    console.error("POST /api/auth/register error:", err);
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
    console.error("POST /api/auth/login error:", err);
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
    console.error("GET /api/auth/me error:", err);
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
    console.error("PUT /api/auth/me/password error:", err);
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
    console.error("PUT /api/auth/me/api-key error:", err);
    res.status(500).json({ error: "Failed to update API key" });
  }
});

export default router;

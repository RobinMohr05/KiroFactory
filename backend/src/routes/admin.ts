import { Router, type Request, type Response } from "express";
import { getUserId } from "../middleware/auth.js";
import { isFirstUser } from "../db/users.js";
import { getAppSettings, setRegistrationEnabled } from "../db/settings.js";
import { log, toErrorFields } from "../logger.js";

const router = Router();

// ---------------------------------------------------------------------------
// Middleware: require admin (first registered user)
// ---------------------------------------------------------------------------

async function requireAdmin(req: Request, res: Response, next: () => void): Promise<void> {
  try {
    const userId = getUserId(req);
    const admin = await isFirstUser(userId);
    if (!admin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  } catch (err) {
    log.error("route-error", {
      component: "admin",
      ...toErrorFields(err),
      msg: "Failed to verify admin status",
    });
    res.status(500).json({ error: "Failed to verify admin status" });
  }
}

// Apply admin check to all routes in this router
router.use(requireAdmin);

// ---------------------------------------------------------------------------
// GET /api/admin/settings — get current admin settings
// ---------------------------------------------------------------------------

router.get("/settings", async (_req: Request, res: Response) => {
  try {
    const settings = await getAppSettings();
    res.json(settings);
  } catch (err) {
    log.error("route-error", {
      component: "admin",
      method: "GET",
      path: "/api/admin/settings",
      ...toErrorFields(err),
      msg: "Failed to fetch settings",
    });
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/admin/settings — toggle settings (e.g. registration_enabled)
// ---------------------------------------------------------------------------

router.put("/settings", async (req: Request, res: Response) => {
  try {
    const { registrationEnabled } = req.body as {
      registrationEnabled?: boolean;
    };

    if (typeof registrationEnabled === "boolean") {
      await setRegistrationEnabled(registrationEnabled);
    }

    // Return the updated settings
    const settings = await getAppSettings();
    res.json(settings);
  } catch (err) {
    log.error("route-error", {
      component: "admin",
      method: "PUT",
      path: "/api/admin/settings",
      ...toErrorFields(err),
      msg: "Failed to update settings",
    });
    res.status(500).json({ error: "Failed to update settings" });
  }
});

export default router;

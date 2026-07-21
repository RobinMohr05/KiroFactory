/**
 * Error Logger Middleware — Emits structured JSON for 5xx API responses.
 *
 * This middleware runs AFTER route handlers (as an Express error-handling middleware
 * for uncaught errors) and also as a response-finish hook to catch 5xx responses
 * returned by route handlers.
 *
 * The structured logs are picked up by Azure Monitor via ContainerAppConsoleLogs_CL
 * and feed into the "API Error Rate" alert rule and workbook panel.
 */

import type { Request, Response, NextFunction } from "express";
import { logApiError } from "../logger.js";

/**
 * Attaches a `finish` listener to each response to detect 5xx status codes.
 * Must be registered BEFORE route handlers (app.use(apiErrorLogger)).
 */
export function apiErrorLogger(req: Request, res: Response, next: NextFunction): void {
  res.on("finish", () => {
    if (res.statusCode >= 500) {
      logApiError(
        res.statusCode,
        req.method,
        req.originalUrl,
        res.statusMessage || "Internal Server Error"
      );
    }
  });
  next();
}

/**
 * Express error-handling middleware (4 args).
 * Catches uncaught errors thrown by route handlers and logs them as 5xx.
 * Must be registered AFTER route handlers.
 */
export function uncaughtErrorLogger(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  logApiError(500, req.method, req.originalUrl, err.message || "Unhandled error");

  // Pass to Express default error handler if headers not sent
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal Server Error" });
  } else {
    next(err);
  }
}

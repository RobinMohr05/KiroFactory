import type { Request, Response, NextFunction } from "express";
import { isDbAvailable } from "../db/connection.js";

/**
 * DB-availability guard for DB-dependent API routers.
 *
 * index.ts binds the HTTP port BEFORE connecting to AuraDB (see the `start()`
 * comment about ECONNREFUSED) and explicitly supports running while the DB is
 * unavailable at startup. Mounting this in front of a DB-dependent router means
 * a request arriving in that window (or during a DB outage) gets a clean,
 * actionable 503 instead of throwing inside the DB layer and surfacing as a
 * generic 500.
 */
export function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!isDbAvailable()) {
    res.status(503).json({
      error: "Database is currently unavailable. Some features may not work until the connection is restored.",
    });
    return;
  }
  next();
}

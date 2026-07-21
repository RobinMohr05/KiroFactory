import { getPool, sql } from "./connection.js";
import type { AppSettings } from "../types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a setting value by key.
 */
export async function getSetting(key: string): Promise<string | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("key", sql.NVarChar(100), key)
    .query("SELECT value FROM settings WHERE [key] = @key");

  if (result.recordset.length === 0) return null;
  return result.recordset[0].value as string;
}

/**
 * Set a setting value (upsert).
 */
export async function setSetting(key: string, value: string): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input("key", sql.NVarChar(100), key)
    .input("value", sql.NVarChar(sql.MAX), value)
    .query(`
      MERGE settings AS target
      USING (SELECT @key AS [key]) AS source
      ON target.[key] = source.[key]
      WHEN MATCHED THEN
        UPDATE SET value = @value, updated_at = GETUTCDATE()
      WHEN NOT MATCHED THEN
        INSERT ([key], value) VALUES (@key, @value);
    `);
}

/**
 * Get the app-level settings object.
 */
export async function getAppSettings(): Promise<AppSettings> {
  const regEnabled = await getSetting("registration_enabled");
  return {
    registrationEnabled: regEnabled === "1",
  };
}

/**
 * Check if user registration is enabled.
 */
export async function isRegistrationEnabled(): Promise<boolean> {
  const value = await getSetting("registration_enabled");
  return value === "1";
}

/**
 * Enable or disable user registration.
 */
export async function setRegistrationEnabled(enabled: boolean): Promise<void> {
  await setSetting("registration_enabled", enabled ? "1" : "0");
}

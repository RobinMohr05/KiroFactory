import type { ManagedTransaction } from "neo4j-driver";
import { readQuery, writeQuery } from "./connection.js";
import type { AppSettings } from "../types.js";

/**
 * `:Settings` nodes are one-per-key, but unlike a generic SQL key/value
 * table, each key can use whatever property shape actually fits it —
 * there's no single `value` column forcing every setting into a string.
 *
 * `registration_enabled` is the one exception worth calling out: it's
 * stored with a dedicated boolean `enabled` property
 * (`:Settings {key: 'registration_enabled', enabled: boolean}`) instead of
 * the generic string `value` property every other key falls back to. This
 * is a deliberate correctness fix carried over from the migration design,
 * not an arbitrary modeling choice — the old SQL-backed version had three
 * different, mutually-inconsistent conventions for this one value:
 *
 *   - `schema.sql` seeded the string `'true'` for a fresh install.
 *   - `migrate.ts`'s incremental upgrade path seeded `'0'` instead.
 *   - The read path (see `isRegistrationEnabled` below) only ever
 *     recognized the literal string `"1"` as "enabled".
 *
 * Neither `'true'` nor `'0'` is `"1"`, so a fresh install's seed value has
 * always silently evaluated as disabled, regardless of which seed path
 * ran and regardless of the value looking like it should mean "enabled".
 * Storing a real boolean removes the ambiguous string convention entirely
 * instead of picking one of the three to carry forward.
 */
const REGISTRATION_ENABLED_KEY = "registration_enabled";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a setting value by key.
 *
 * Kept string-typed at this API boundary so any generic caller still sees
 * the same `Promise<string | null>` contract as before. Internally,
 * `registration_enabled` is backed by the dedicated `enabled` boolean node
 * property described above — this function translates that boolean back to
 * the "1"/"0" string convention (returning null if the node doesn't exist
 * yet, matching the original's "no row -> null" behavior). Every other key
 * falls back to a generic `:Settings {key, value}` node with a string
 * `value` property. Prefer `isRegistrationEnabled()` below for that
 * specific setting — it reads the boolean directly instead of round-tripping
 * through this string translation.
 */
export async function getSetting(key: string): Promise<string | null> {
  if (key === REGISTRATION_ENABLED_KEY) {
    return readQuery(async (tx: ManagedTransaction) => {
      const result = await tx.run(
        "MATCH (s:Settings {key: $key}) RETURN s.enabled AS enabled",
        { key }
      );
      if (result.records.length === 0) return null;
      const enabled = result.records[0].get("enabled") as boolean | null;
      if (enabled === null) return null;
      return enabled ? "1" : "0";
    });
  }

  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      "MATCH (s:Settings {key: $key}) RETURN s.value AS value",
      { key }
    );
    if (result.records.length === 0) return null;
    return result.records[0].get("value") as string;
  });
}

/**
 * Set a setting value (upsert).
 *
 * `registration_enabled` writes to the dedicated `enabled` boolean property,
 * translating the "1"/"0" string convention at this boundary. Every other
 * key upserts a generic `:Settings {key, value}` node via
 * `MERGE ... ON CREATE SET ... ON MATCH SET ...` — the direct Cypher
 * equivalent of the original's SQL `MERGE` upsert.
 */
export async function setSetting(key: string, value: string): Promise<void> {
  if (key === REGISTRATION_ENABLED_KEY) {
    const enabled = value === "1";
    await writeQuery(async (tx: ManagedTransaction) => {
      await tx.run(
        "MERGE (s:Settings {key: $key}) SET s.enabled = $enabled",
        { key, enabled }
      );
    });
    return;
  }

  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      `MERGE (s:Settings {key: $key})
       ON CREATE SET s.value = $value
       ON MATCH SET s.value = $value`,
      { key, value }
    );
  });
}

/**
 * Get the app-level settings object.
 */
export async function getAppSettings(): Promise<AppSettings> {
  const regEnabled = await getSetting(REGISTRATION_ENABLED_KEY);
  return {
    registrationEnabled: regEnabled === "1",
  };
}

/**
 * Check if user registration is enabled.
 *
 * Reads the `enabled` boolean property directly rather than round-tripping
 * through getSetting()'s string translation, since this is the one caller
 * that actually cares about the real underlying value. Defaults to false if
 * the node doesn't exist yet, matching the original's behavior of an absent
 * row producing `value === "1"` === false.
 */
export async function isRegistrationEnabled(): Promise<boolean> {
  return readQuery(async (tx: ManagedTransaction) => {
    const result = await tx.run(
      "MATCH (s:Settings {key: $key}) RETURN s.enabled AS enabled",
      { key: REGISTRATION_ENABLED_KEY }
    );
    if (result.records.length === 0) return false;
    return (result.records[0].get("enabled") as boolean | null) ?? false;
  });
}

/**
 * Enable or disable user registration.
 */
export async function setRegistrationEnabled(enabled: boolean): Promise<void> {
  await writeQuery(async (tx: ManagedTransaction) => {
    await tx.run(
      "MERGE (s:Settings {key: $key}) SET s.enabled = $enabled",
      { key: REGISTRATION_ENABLED_KEY, enabled }
    );
  });
}

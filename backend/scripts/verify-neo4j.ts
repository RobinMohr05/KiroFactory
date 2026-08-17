/**
 * Neo4j AuraDB connectivity check — sandbox/evaluation only.
 *
 * This is NOT wired into the running app. Nothing in src/ imports neo4j-driver
 * yet — Azure SQL (backend/src/db/*.ts) remains the actual database. This
 * script only confirms that a AuraDB Free instance is reachable with the
 * driver and credentials in .env, as a first step while evaluating Neo4j.
 *
 * Setup:
 *   1. Create a free instance at https://console.neo4j.io (one per account).
 *   2. Copy the generated URI/username/password into backend/.env
 *      (NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, optionally NEO4J_DATABASE)
 *      — see .env.example. Aura's downloadable credentials file uses this
 *      exact NEO4J_ and AURA_ variable naming, so it can be pasted in as-is.
 *      The password is shown only once at creation time.
 *   3. npm run verify:neo4j -w backend
 *
 * What it does:
 *   - Opens a driver session and runs `RETURN 1` to confirm connectivity.
 *   - Writes one throwaway node and deletes it, to confirm write access
 *     (AuraDB Free instances can occasionally end up read-only — see
 *     Neo4j community reports on "Write on Read Only Access" errors).
 *   - Reports the server version/edition.
 *   - Closes the driver cleanly on exit.
 */

import dotenv from "dotenv";
dotenv.config();

import neo4j from "neo4j-driver";

const uri = process.env.NEO4J_URI;
const user = process.env.NEO4J_USERNAME;
const password = process.env.NEO4J_PASSWORD;
// Optional — AuraDB instances don't always default to a database literally
// named "neo4j"; when set, pin the session to it instead of the driver default.
const database = process.env.NEO4J_DATABASE;

async function main(): Promise<void> {
  if (!uri || !user || !password) {
    console.error(
      "[verify-neo4j] Missing NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD in backend/.env.\n" +
        "See backend/.env.example for the AuraDB Free setup steps."
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[verify-neo4j] Connecting to ${uri} as ${user}${database ? ` (database: ${database})` : ""}...`
  );
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

  try {
    // Verifies connectivity and credentials before running anything else.
    const info = await driver.getServerInfo();
    console.log(
      `[verify-neo4j] ✓ Connected — server agent: ${info.agent}, protocol: ${info.protocolVersion}`
    );

    const session = driver.session(database ? { database } : undefined);
    try {
      const pingResult = await session.run("RETURN 1 AS ok");
      console.log(`[verify-neo4j] ✓ Query roundtrip ok: ${pingResult.records[0].get("ok")}`);

      // Write + delete a throwaway node to confirm write access (not just read).
      await session.run(
        "CREATE (n:VerifyNeo4jProbe {createdAt: datetime()}) RETURN n"
      );
      const deleteResult = await session.run(
        "MATCH (n:VerifyNeo4jProbe) DETACH DELETE n RETURN count(n) AS deleted"
      );
      console.log(
        `[verify-neo4j] ✓ Write access confirmed (probe node created and cleaned up)`
      );

      const countsResult = await session.run(
        "MATCH (n) RETURN count(n) AS nodeCount"
      );
      console.log(
        `[verify-neo4j] Current node count in instance: ${countsResult.records[0].get("nodeCount")}`
      );
    } finally {
      await session.close();
    }

    console.log("[verify-neo4j] All checks passed.");
  } catch (err) {
    console.error("[verify-neo4j] ✗ Connection or query failed:", err);
    process.exitCode = 1;
  } finally {
    await driver.close();
  }
}

main();

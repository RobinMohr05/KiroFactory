/**
 * Session Sanitization — strips sensitive fields before sending to clients.
 *
 * `rawMcpServers` contains authentication tokens (PATs) that should never
 * reach the browser. This utility creates a safe copy of the session for
 * WebSocket broadcasts and REST API responses.
 */

import type { Session } from "./types.js";

/**
 * Returns a copy of the session with sensitive server-only fields removed.
 * Currently strips `rawMcpServers` which may contain PATs in headers/env.
 *
 * Does NOT mutate the original session object.
 */
export function sanitizeSessionForClient(session: Session): Omit<Session, "rawMcpServers"> {
  // Destructure out the sensitive field, return the rest
  const { rawMcpServers: _stripped, ...safe } = session;
  return safe;
}

/**
 * Tests for session sanitization — stripping sensitive fields
 * (rawMcpServers containing PATs) before sending to clients.
 */

import { describe, it, expect } from "vitest";
import { sanitizeSessionForClient } from "./session-sanitize.js";
import type { Session } from "./types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 1,
    name: "Test Session",
    agent: "",
    status: "running",
    prompt: "test prompt",
    interactive: true,
    loop: false,
    runs: 0,
    intervalSeconds: 10,
    cwd: "/workspace",
    timeoutSeconds: 0,
    tabIds: [1],
    userId: 1,
    createdAt: "2026-08-13T00:00:00Z",
    output: [],
    pinned: false,
    isPermanent: false,
    sortOrder: 0,
    ...overrides,
  };
}

describe("sanitizeSessionForClient", () => {
  it("strips rawMcpServers from the session object", () => {
    const session = makeSession({
      rawMcpServers: [
        {
          type: "http",
          name: "github",
          url: "https://api.githubcopilot.com/mcp/",
          headers: [{ name: "Authorization", value: "Bearer ghp_secret123" }],
        },
      ],
    });

    const sanitized = sanitizeSessionForClient(session);

    expect(sanitized).not.toHaveProperty("rawMcpServers");
  });

  it("preserves all other session fields including forceLocal", () => {
    const session = makeSession({
      rawMcpServers: [{ type: "http", name: "github", url: "https://example.com", headers: [] }],
      forceLocal: true,
      model: "claude-sonnet-4",
      mcpServers: [{ name: "test", command: "echo", args: [], env: [] }],
    });

    const sanitized = sanitizeSessionForClient(session);

    expect(sanitized.id).toBe(1);
    expect(sanitized.name).toBe("Test Session");
    expect(sanitized.forceLocal).toBe(true);
    expect(sanitized.model).toBe("claude-sonnet-4");
    expect(sanitized.mcpServers).toEqual([{ name: "test", command: "echo", args: [], env: [] }]);
  });

  it("returns session unchanged when rawMcpServers is undefined", () => {
    const session = makeSession({ rawMcpServers: undefined });

    const sanitized = sanitizeSessionForClient(session);

    expect(sanitized).not.toHaveProperty("rawMcpServers");
    expect(sanitized.name).toBe("Test Session");
  });

  it("does not mutate the original session object", () => {
    const session = makeSession({
      rawMcpServers: [{ type: "http", name: "github", url: "https://example.com", headers: [] }],
    });

    sanitizeSessionForClient(session);

    // Original still has rawMcpServers
    expect(session.rawMcpServers).toBeDefined();
  });

  it("preserves forceLocal flag value accurately", () => {
    const sessionWithForce = makeSession({ forceLocal: true });
    const sessionWithoutForce = makeSession({ forceLocal: false });
    const sessionUndefined = makeSession({});

    expect(sanitizeSessionForClient(sessionWithForce).forceLocal).toBe(true);
    expect(sanitizeSessionForClient(sessionWithoutForce).forceLocal).toBe(false);
    expect(sanitizeSessionForClient(sessionUndefined).forceLocal).toBeUndefined();
  });
});

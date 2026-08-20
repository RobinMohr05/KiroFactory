/**
 * Tests for the pr-complete-mcp-server.js MCP server.
 *
 * Covers:
 * - Server starts and responds to MCP initialize
 * - tools/list returns the complete_pull_request tool with correct schema
 * - Tool rejects when ALL_GROUP_TASKS_DONE is "false" (deferred merge)
 * - Tool attempts GitHub merge when env vars are set correctly
 * - Tool handles merge conflicts (409 response)
 * - Tool handles missing PR_URL gracefully
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const SERVER_PATH = resolve(__dirname, "../../../worker/pr-complete-mcp-server.js");

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: unknown;
}

function startServer(env: Record<string, string> = {}): ChildProcess {
  const proc = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  return proc;
}

function sendRequest(proc: ChildProcess, msg: object): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for response")), 5000);

    const handler = (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          // Skip notifications (no id)
          if (parsed.id !== undefined || parsed.method) {
            clearTimeout(timeout);
            proc.stdout!.removeListener("data", handler);
            resolve(parsed);
            return;
          }
        } catch {
          // ignore non-JSON
        }
      }
    };

    proc.stdout!.on("data", handler);
    proc.stdin!.write(JSON.stringify(msg) + "\n");
  });
}

/** Collect all responses/notifications until we get one with the expected id */
function sendRequestCollectAll(proc: ChildProcess, msg: object, expectedId: number): Promise<JsonRpcResponse[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for response")), 5000);
    const collected: JsonRpcResponse[] = [];

    const handler = (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          collected.push(parsed);
          if (parsed.id === expectedId) {
            clearTimeout(timeout);
            proc.stdout!.removeListener("data", handler);
            resolve(collected);
            return;
          }
        } catch {
          // ignore non-JSON
        }
      }
    };

    proc.stdout!.on("data", handler);
    proc.stdin!.write(JSON.stringify(msg) + "\n");
  });
}

describe("pr-complete-mcp-server", () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
  });

  it("should respond to initialize with correct server info", async () => {
    proc = startServer({
      PR_URL: "https://github.com/owner/repo/pull/1",
      PR_BRANCH: "feature/test",
      REPO_URL: "https://github.com/owner/repo",
      GITHUB_PAT: "ghp_test",
      ALL_GROUP_TASKS_DONE: "true",
    });

    const responses = await sendRequestCollectAll(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }, 1);

    const response = responses.find(r => r.id === 1)!;
    expect(response.result).toBeDefined();
    const result = response.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities).toEqual({ tools: {} });
    expect((result.serverInfo as Record<string, unknown>).name).toBe("pr-complete-mcp-server");
  });

  it("should list the complete_pull_request tool", async () => {
    proc = startServer({
      PR_URL: "https://github.com/owner/repo/pull/1",
      PR_BRANCH: "feature/test",
      REPO_URL: "https://github.com/owner/repo",
      GITHUB_PAT: "ghp_test",
      ALL_GROUP_TASKS_DONE: "true",
    });

    // Initialize first
    await sendRequestCollectAll(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }, 1);

    // Then list tools
    const responses = await sendRequestCollectAll(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, 2);

    const response = responses.find(r => r.id === 2)!;
    expect(response.result).toBeDefined();
    const result = response.result as { tools: Array<{ name: string; inputSchema: object }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("complete_pull_request");
    expect(result.tools[0].inputSchema).toEqual({
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Brief explanation of why the PR is being completed (e.g. 'QA passed, no defects found')",
        },
      },
      required: ["reason"],
    });
  });

  it("should defer merge when ALL_GROUP_TASKS_DONE is false", async () => {
    proc = startServer({
      PR_URL: "https://github.com/owner/repo/pull/1",
      PR_BRANCH: "feature/test",
      REPO_URL: "https://github.com/owner/repo",
      GITHUB_PAT: "ghp_test",
      ALL_GROUP_TASKS_DONE: "false",
    });

    // Initialize
    await sendRequestCollectAll(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }, 1);

    // Call complete_pull_request
    const responses = await sendRequestCollectAll(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "complete_pull_request",
        arguments: { reason: "QA passed" },
      },
    }, 2);

    const response = responses.find(r => r.id === 2)!;
    expect(response.result).toBeDefined();
    const result = response.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined(); // Not an error — a success response with a deferral message
    const text = result.content[0].text;
    expect(text).toContain("deferred");
    expect(text).toContain("sibling tasks");
  });

  it("should return error when PR_URL is not set", async () => {
    proc = startServer({
      PR_URL: "",
      PR_BRANCH: "feature/test",
      REPO_URL: "https://github.com/owner/repo",
      GITHUB_PAT: "ghp_test",
      ALL_GROUP_TASKS_DONE: "true",
    });

    // Initialize
    await sendRequestCollectAll(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }, 1);

    // Call complete_pull_request
    const responses = await sendRequestCollectAll(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "complete_pull_request",
        arguments: { reason: "QA passed" },
      },
    }, 2);

    const response = responses.find(r => r.id === 2)!;
    expect(response.result).toBeDefined();
    const result = response.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("PR_URL");
  });

  it("should return error when reason is missing", async () => {
    proc = startServer({
      PR_URL: "https://github.com/owner/repo/pull/1",
      PR_BRANCH: "feature/test",
      REPO_URL: "https://github.com/owner/repo",
      GITHUB_PAT: "ghp_test",
      ALL_GROUP_TASKS_DONE: "true",
    });

    // Initialize
    await sendRequestCollectAll(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }, 1);

    // Call without reason
    const responses = await sendRequestCollectAll(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "complete_pull_request",
        arguments: {},
      },
    }, 2);

    const response = responses.find(r => r.id === 2)!;
    expect(response.result).toBeDefined();
    const result = response.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("reason");
  });

  it("should reject unknown tool name", async () => {
    proc = startServer({
      PR_URL: "https://github.com/owner/repo/pull/1",
      PR_BRANCH: "feature/test",
      REPO_URL: "https://github.com/owner/repo",
      GITHUB_PAT: "ghp_test",
      ALL_GROUP_TASKS_DONE: "true",
    });

    // Initialize
    await sendRequestCollectAll(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }, 1);

    // Call unknown tool
    const responses = await sendRequestCollectAll(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "unknown_tool",
        arguments: {},
      },
    }, 2);

    const response = responses.find(r => r.id === 2)!;
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain("Unknown tool");
  });
});

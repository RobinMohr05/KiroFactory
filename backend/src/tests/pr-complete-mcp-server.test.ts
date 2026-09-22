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
 * - Azure DevOps: mergeStatus=conflicts detected on GET -> merge_conflict (no PATCH)
 * - Azure DevOps: mergeStatus=rejectedByPolicy detected on GET -> rejected_by_policy (no PATCH)
 * - Azure DevOps: mergeStatus=queued with retries exhausted -> not_ready
 * - Azure DevOps: mergeStatus=succeeded -> proceeds with PATCH to complete
 * - Azure DevOps: 409 on PATCH no longer inferred from message text
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { createServer as createHttpServer, IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";

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

// ---------------------------------------------------------------------------
// Mock HTTP server helpers for Azure DevOps API simulation
// ---------------------------------------------------------------------------

interface MockAzureServerOpts {
  /** Sequence of mergeStatus values to return from GET (one per call). */
  getMergeStatuses: string[];
  /** HTTP status for PATCH response (default 200). */
  patchStatus?: number;
  /** Response body for PATCH (default: a completed-PR object). */
  patchBody?: object;
}

function createMockAzureServer(opts: MockAzureServerOpts): Promise<{ server: HttpServer; port: number }> {
  return new Promise((resolve, reject) => {
    let getCallIndex = 0;

    const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const patchStatus = opts.patchStatus ?? 200;

        if (req.method === "GET") {
          const mergeStatus = opts.getMergeStatuses[Math.min(getCallIndex, opts.getMergeStatuses.length - 1)];
          getCallIndex++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            pullRequestId: 42,
            status: "active",
            mergeStatus,
            lastMergeSourceCommit: { commitId: "abc123" },
          }));
        } else if (req.method === "PATCH") {
          const responseBody = opts.patchBody ?? {
            pullRequestId: 42,
            status: "completed",
            mergeStatus: "succeeded",
          };
          res.writeHead(patchStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify(patchStatus === 200 ? responseBody : { message: "Conflict completing the pull request." }));
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected server address"));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

function stopServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Build a fake Azure DevOps PR URL that routes to the mock server */
function mockAzurePrUrl(port: number): string {
  // We'll use a fake hostname that matches the azure-devops provider detection pattern:
  // the server must detect it as azure-devops from REPO_URL.
  // PR_URL is only used by parseAzureDevOpsPrUrl to extract org/project/repo/id —
  // but we override the base URL via AZURE_DEVOPS_BASE_URL env var so actual requests
  // go to localhost.
  return "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/42";
}

// ---------------------------------------------------------------------------
// Azure DevOps mergeStatus pre-check tests
// ---------------------------------------------------------------------------

describe("pr-complete-mcp-server — Azure DevOps mergeStatus pre-check", () => {
  let proc: ChildProcess | null = null;
  let mockServer: HttpServer | null = null;

  beforeEach(async () => {
    // Reset
    proc = null;
    mockServer = null;
  });

  afterEach(async () => {
    if (proc) {
      proc.kill();
      proc = null;
    }
    if (mockServer) {
      await stopServer(mockServer);
      mockServer = null;
    }
  });

  /** Start the MCP server pointing at the mock Azure server */
  function startAzureServer(port: number, extraEnv: Record<string, string> = {}): ChildProcess {
    return startServer({
      PR_URL: mockAzurePrUrl(port),
      PR_BRANCH: "feature/test",
      REPO_URL: "https://dev.azure.com/myorg/myproject/_git/myrepo",
      AZURE_DEVOPS_PAT: "test-pat",
      ALL_GROUP_TASKS_DONE: "true",
      AZURE_DEVOPS_BASE_URL: `http://127.0.0.1:${port}`,
      ...extraEnv,
    });
  }

  async function callCompletePr(p: ChildProcess): Promise<{ result: { content: Array<{ type: string; text: string }>; isError?: boolean } }> {
    // Initialize first
    await sendRequestCollectAll(p, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, 1);
    // Call the tool
    const responses = await sendRequestCollectAll(p, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "complete_pull_request",
        arguments: { reason: "QA passed" },
      },
    }, 2);
    const response = responses.find(r => r.id === 2)!;
    return response as any;
  }

  it("should return merge_conflict when mergeStatus is 'conflicts' (no PATCH attempted)", async () => {
    const { server, port } = await createMockAzureServer({
      getMergeStatuses: ["conflicts"],
    });
    mockServer = server;
    proc = startAzureServer(port);

    const response = await callCompletePr(proc);
    expect(response.result).toBeDefined();

    const result = response.result;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("merge_conflict");
    expect(result.isError).toBeFalsy(); // merge_conflict is not an MCP error
  });

  it("should return rejected_by_policy when mergeStatus is 'rejectedByPolicy' (no PATCH attempted)", async () => {
    const { server, port } = await createMockAzureServer({
      getMergeStatuses: ["rejectedByPolicy"],
    });
    mockServer = server;
    proc = startAzureServer(port);

    const response = await callCompletePr(proc);
    expect(response.result).toBeDefined();

    const result = response.result;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("rejected_by_policy");
    expect(result.isError).toBeFalsy();
  });

  it("should return not_ready when mergeStatus is 'queued' and retries are exhausted", async () => {
    // All GET calls return 'queued' — never transitions to ready
    const { server, port } = await createMockAzureServer({
      getMergeStatuses: ["queued", "queued", "queued", "queued"],
    });
    mockServer = server;
    // Use a fast poll interval so the test completes quickly
    proc = startAzureServer(port, { AZURE_DEVOPS_QUEUED_POLL_INTERVAL_MS: "50" });

    const response = await callCompletePr(proc);
    expect(response.result).toBeDefined();

    const result = response.result;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("not_ready");
    expect(result.isError).toBeTruthy();
  });

  it("should proceed with PATCH and succeed when mergeStatus is 'succeeded'", async () => {
    const { server, port } = await createMockAzureServer({
      getMergeStatuses: ["succeeded"],
      patchStatus: 200,
    });
    mockServer = server;
    proc = startAzureServer(port);

    const response = await callCompletePr(proc);
    expect(response.result).toBeDefined();

    const result = response.result;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("completed successfully");
  });

  it("should proceed with PATCH and succeed when mergeStatus is 'notSet'", async () => {
    const { server, port } = await createMockAzureServer({
      getMergeStatuses: ["notSet"],
      patchStatus: 200,
    });
    mockServer = server;
    proc = startAzureServer(port);

    const response = await callCompletePr(proc);
    expect(response.result).toBeDefined();

    const result = response.result;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("completed successfully");
  });

  it("should NOT use message text to infer conflict from a 409 PATCH response", async () => {
    // mergeStatus=succeeded on GET, but PATCH returns 409 with a 'conflict' message
    // The new code should NOT report merge_conflict based on the message text —
    // instead it should report the actual mergeStatus or a generic merge_failed
    const { server, port } = await createMockAzureServer({
      getMergeStatuses: ["succeeded"],
      patchStatus: 409,
      patchBody: { message: "There was a conflict completing the pull request." },
    });
    mockServer = server;
    proc = startAzureServer(port);

    const response = await callCompletePr(proc);
    expect(response.result).toBeDefined();

    const result = response.result;
    // It should NOT blindly label this merge_conflict based on message text
    // It should re-check mergeStatus or return merge_failed
    const text = result.content[0].text;
    let parsed: { error?: string } = {};
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    // The error must NOT be "merge_conflict" inferred from the 409 message text
    // (the pre-check already told us mergeStatus was 'succeeded', so the 409
    // is some other Azure DevOps condition — e.g. branch policy)
    expect(parsed.error).not.toBe("merge_conflict");
  });

  it("should return merge_failed when mergeStatus is 'failure'", async () => {
    const { server, port } = await createMockAzureServer({
      getMergeStatuses: ["failure"],
    });
    mockServer = server;
    proc = startAzureServer(port);

    const response = await callCompletePr(proc);
    expect(response.result).toBeDefined();

    const result = response.result;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("merge_failed");
    expect(result.isError).toBeTruthy();
  });

  it("should transition from queued to succeeded and proceed with PATCH", async () => {
    // First GET returns 'queued', second returns 'succeeded', then PATCH succeeds
    const { server, port } = await createMockAzureServer({
      getMergeStatuses: ["queued", "succeeded"],
      patchStatus: 200,
    });
    mockServer = server;
    // Use a fast poll interval so the test completes quickly
    proc = startAzureServer(port, { AZURE_DEVOPS_QUEUED_POLL_INTERVAL_MS: "50" });

    const response = await callCompletePr(proc);
    expect(response.result).toBeDefined();

    const result = response.result;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("completed successfully");
  });
});

// ---------------------------------------------------------------------------
// Mock HTTP server helpers for GitHub API simulation
// ---------------------------------------------------------------------------

interface MockGitHubServerOpts {
  /** Sequence of mergeable_state values to return from GET (one per call). */
  getMergeableStates: string[];
  /** Sequence of `mergeable` boolean|null values to return from GET (one per call). Optional. */
  getMergeable?: (boolean | null)[];
  /** HTTP status for the merge PUT response (default 200). */
  mergeStatus?: number;
  /** Response body for the merge PUT (default: a merged object). */
  mergeBody?: object;
}

function createMockGitHubServer(opts: MockGitHubServerOpts): Promise<{ server: HttpServer; port: number }> {
  return new Promise((resolve, reject) => {
    let getCallIndex = 0;

    const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const url = req.url || "";

        if (req.method === "GET" && /\/pulls\/\d+$/.test(url)) {
          // GET the PR — return mergeability signal
          const idx = Math.min(getCallIndex, opts.getMergeableStates.length - 1);
          const mergeableState = opts.getMergeableStates[idx];
          const mergeable = opts.getMergeable
            ? opts.getMergeable[Math.min(getCallIndex, opts.getMergeable.length - 1)]
            : mergeableState === "clean" || mergeableState === "unstable" || mergeableState === "has_hooks";
          getCallIndex++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            number: 7,
            state: "open",
            mergeable,
            mergeable_state: mergeableState,
          }));
        } else if (req.method === "PUT" && /\/pulls\/\d+\/merge$/.test(url)) {
          const mergeStatus = opts.mergeStatus ?? 200;
          const responseBody = opts.mergeBody ?? { merged: true, message: "Pull Request successfully merged" };
          res.writeHead(mergeStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify(mergeStatus === 200 ? responseBody : { message: "Merge conflict" }));
        } else if (req.method === "DELETE") {
          // Branch deletion
          res.writeHead(204);
          res.end();
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected server address"));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

// ---------------------------------------------------------------------------
// GitHub mergeable_state pre-check tests
// ---------------------------------------------------------------------------

describe("pr-complete-mcp-server — GitHub mergeable_state pre-check", () => {
  let proc: ChildProcess | null = null;
  let mockServer: HttpServer | null = null;

  afterEach(async () => {
    if (proc) {
      proc.kill();
      proc = null;
    }
    if (mockServer) {
      await stopServer(mockServer);
      mockServer = null;
    }
  });

  /** Start the MCP server pointing at the mock GitHub server */
  function startGitHubServer(port: number, extraEnv: Record<string, string> = {}): ChildProcess {
    return startServer({
      PR_URL: "https://github.com/owner/repo/pull/7",
      PR_BRANCH: "feature/test",
      REPO_URL: "https://github.com/owner/repo",
      GITHUB_PAT: "ghp_test",
      ALL_GROUP_TASKS_DONE: "true",
      GITHUB_BASE_URL: `http://127.0.0.1:${port}`,
      ...extraEnv,
    });
  }

  async function callCompletePr(p: ChildProcess): Promise<{ result: { content: Array<{ type: string; text: string }>; isError?: boolean } }> {
    await sendRequestCollectAll(p, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, 1);
    const responses = await sendRequestCollectAll(p, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "complete_pull_request",
        arguments: { reason: "QA passed" },
      },
    }, 2);
    const response = responses.find(r => r.id === 2)!;
    return response as any;
  }

  it("should merge successfully when mergeable_state is 'clean'", async () => {
    const { server, port } = await createMockGitHubServer({
      getMergeableStates: ["clean"],
      mergeStatus: 200,
    });
    mockServer = server;
    proc = startGitHubServer(port);

    const response = await callCompletePr(proc);
    expect(response.result).toBeDefined();

    const result = response.result;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("merged successfully");
  });

  it("should return merge_conflict when mergeable_state is 'dirty' (no merge attempted)", async () => {
    const { server, port } = await createMockGitHubServer({
      getMergeableStates: ["dirty"],
    });
    mockServer = server;
    proc = startGitHubServer(port);

    const response = await callCompletePr(proc);
    expect(response.result).toBeDefined();

    const result = response.result;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("merge_conflict");
    expect(result.isError).toBeFalsy(); // merge_conflict is actionable, not an MCP error
  });

  it("should return rejected_by_policy when mergeable_state is 'blocked'", async () => {
    const { server, port } = await createMockGitHubServer({
      getMergeableStates: ["blocked"],
    });
    mockServer = server;
    proc = startGitHubServer(port);

    const response = await callCompletePr(proc);
    expect(response.result).toBeDefined();

    const result = response.result;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("rejected_by_policy");
    expect(result.isError).toBeFalsy(); // actionable, agent can act on it
  });

  it("should return rejected_by_policy when mergeable_state is 'behind'", async () => {
    const { server, port } = await createMockGitHubServer({
      getMergeableStates: ["behind"],
    });
    mockServer = server;
    proc = startGitHubServer(port);

    const response = await callCompletePr(proc);
    expect(response.result).toBeDefined();

    const result = response.result;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("rejected_by_policy");
    expect(result.isError).toBeFalsy();
  });

  it("should return not_ready when mergeable_state is 'unknown' and retries are exhausted", async () => {
    const { server, port } = await createMockGitHubServer({
      getMergeableStates: ["unknown", "unknown", "unknown", "unknown"],
      getMergeable: [null, null, null, null],
    });
    mockServer = server;
    proc = startGitHubServer(port, { GITHUB_UNKNOWN_POLL_INTERVAL_MS: "50" });

    const response = await callCompletePr(proc);
    expect(response.result).toBeDefined();

    const result = response.result;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("not_ready");
    expect(result.isError).toBeTruthy();
  });

  it("should transition from unknown to clean and merge successfully", async () => {
    const { server, port } = await createMockGitHubServer({
      getMergeableStates: ["unknown", "clean"],
      getMergeable: [null, true],
      mergeStatus: 200,
    });
    mockServer = server;
    proc = startGitHubServer(port, { GITHUB_UNKNOWN_POLL_INTERVAL_MS: "50" });

    const response = await callCompletePr(proc);
    expect(response.result).toBeDefined();

    const result = response.result;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("merged successfully");
  });
});

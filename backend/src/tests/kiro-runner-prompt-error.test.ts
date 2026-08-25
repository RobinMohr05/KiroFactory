/**
 * Tests for KiroRunner.prompt() error propagation.
 *
 * Verifies that when `this.conn.prompt(...)` rejects, the error is
 * NOT silently swallowed but instead propagated to the caller of the
 * async generator, and logged server-side.
 *
 * Reproduces the bug described in Task #597: a rejected ACP prompt
 * call causes the generator to simply stop yielding and return as if
 * the turn completed normally, with no error surfaced to the caller.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the logger so we can verify log.error() is called
vi.mock("../logger.js", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  toErrorFields: (err: unknown) => ({
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  }),
}));

// We'll construct a minimal KiroRunner instance via internal access
// to test the prompt() method's error behavior in isolation.
import { KiroRunner } from "../agent/kiro-runner.js";
import { log } from "../logger.js";

/**
 * Helper: create a minimal KiroRunner-like instance with mocked internals.
 * Since the constructor is private, we use Object.create + manual field setup
 * to simulate the state the class would be in after successful initialization.
 */
function createMockRunner(opts: {
  connPromptFn: () => Promise<void>;
}): KiroRunner {
  const runner = Object.create(KiroRunner.prototype) as any;
  runner.sessionId = "test-session-123";
  runner.turnDone = false;
  runner.updateQueue = [];
  runner.updateResolve = null;
  runner._lastTurnCredits = 0;
  runner._mcpServerInitFailures = [];
  runner.conn = {
    prompt: opts.connPromptFn,
  };
  // Minimal proc mock for isAlive check
  runner.proc = { exitCode: null, pid: 1234 };
  return runner as KiroRunner;
}

describe("KiroRunner.prompt() error propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should throw the error to the caller when conn.prompt() rejects", async () => {
    const promptError = new Error("ACP auth failure: token expired");

    const runner = createMockRunner({
      connPromptFn: () => Promise.reject(promptError),
    });

    // Consume the async generator — should throw
    const updates: any[] = [];
    await expect(async () => {
      for await (const update of runner.prompt("Hello")) {
        updates.push(update);
      }
    }).rejects.toThrow("ACP auth failure: token expired");
  });

  it("should log the error server-side via log.error()", async () => {
    const promptError = new Error("Malformed ACP request");

    const runner = createMockRunner({
      connPromptFn: () => Promise.reject(promptError),
    });

    // Consume the generator, ignoring the throw
    try {
      for await (const _update of runner.prompt("Hello")) {
        // no updates expected
      }
    } catch {
      // expected
    }

    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("prompt"),
      expect.objectContaining({
        error: "Malformed ACP request",
      })
    );
  });

  it("should NOT throw when conn.prompt() resolves successfully", async () => {
    const runner = createMockRunner({
      connPromptFn: () => Promise.resolve(),
    });

    // The turn completes normally — no error should be thrown
    const updates: any[] = [];
    // If this throws, the test fails automatically
    for await (const update of runner.prompt("Hello")) {
      updates.push(update);
    }
    // Reaching here means no error was thrown — success path works
    expect(true).toBe(true);
  });

  it("should still yield updates received before the error", async () => {
    // Simulate: some updates arrive before the prompt promise rejects
    let resolveDelay: () => void;
    const delay = new Promise<void>((r) => { resolveDelay = r; });

    const runner = createMockRunner({
      connPromptFn: () => delay.then(() => { throw new Error("Late failure"); }),
    });

    const updates: any[] = [];
    const runnerAny = runner as any;

    // Simulate an update arriving before the error
    setTimeout(() => {
      runnerAny.updateQueue.push({ sessionUpdate: "partial text" });
      runnerAny.updateResolve?.();
      runnerAny.updateResolve = null;
    }, 10);

    // Then reject after a short delay
    setTimeout(() => {
      resolveDelay!();
    }, 30);

    await expect(async () => {
      for await (const update of runner.prompt("Hello")) {
        updates.push(update);
      }
    }).rejects.toThrow("Late failure");

    // The update that arrived before the error should still have been yielded
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ sessionUpdate: "partial text" });
  });
});

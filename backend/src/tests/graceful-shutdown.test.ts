/**
 * Tests for the graceful shutdown improvements in index.ts (task #2013).
 *
 * The shutdown() handler must:
 * 1. Guard against double-invocation (second SIGTERM is a no-op).
 * 2. Call server.close() FIRST to stop accepting new connections.
 * 3. Wrap all async teardown steps in a Promise.race against a ~30s timeout
 *    that calls process.exit(1) if exceeded.
 * 4. Unref the timeout timer so it doesn't hold the event loop open.
 *
 * Because the logic lives in a module-level closure in index.ts (which also
 * binds a port and talks to Neo4j), we test via the extracted
 * createShutdownHandler() helper that index.ts delegates to. This keeps the
 * logic unit-testable without spinning up the full server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createShutdownHandler } from "../shutdown-handler.js";

describe("createShutdownHandler", () => {
  let serverCloseMock: ReturnType<typeof vi.fn<() => void>>;
  let shutdownAllSessionsMock: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let plannerShutdownMock: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let closePoolMock: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let processExitMock: ReturnType<typeof vi.fn<(code: number) => void>>;
  let handler: () => Promise<void>;

  beforeEach(() => {
    serverCloseMock = vi.fn<() => void>();
    shutdownAllSessionsMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    plannerShutdownMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    closePoolMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    processExitMock = vi.fn<(code: number) => void>();

    handler = createShutdownHandler({
      serverClose: serverCloseMock,
      shutdownAllSessions: shutdownAllSessionsMock,
      plannerShutdown: plannerShutdownMock,
      closePool: closePoolMock,
      processExit: processExitMock,
      timeoutMs: 100, // Fast timeout for tests
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls server.close() before async teardown steps", async () => {
    const callOrder: string[] = [];
    serverCloseMock.mockImplementation(() => { callOrder.push("server.close"); });
    shutdownAllSessionsMock.mockImplementation(async () => { callOrder.push("shutdownAllSessions"); });

    await handler();

    expect(callOrder[0]).toBe("server.close");
    expect(callOrder[1]).toBe("shutdownAllSessions");
  });

  it("calls process.exit(0) after successful teardown", async () => {
    await handler();
    expect(processExitMock).toHaveBeenCalledWith(0);
    expect(processExitMock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — a second invocation is a no-op", async () => {
    await handler();
    await handler(); // Second call — should not run teardown again

    expect(serverCloseMock).toHaveBeenCalledTimes(1);
    expect(processExitMock).toHaveBeenCalledTimes(1);
  });

  it("calls process.exit(1) when shutdown exceeds the timeout", async () => {
    // Make shutdownAllSessions hang indefinitely
    shutdownAllSessionsMock.mockImplementation(
      () => new Promise<void>(() => { /* never resolves */ })
    );

    // Don't await — let the timeout fire and check side-effects
    const promise = handler();
    // Advance past the 100ms timeout
    await new Promise((resolve) => setTimeout(resolve, 200));
    await promise.catch(() => {}); // handler resolves after exit(1)

    expect(processExitMock).toHaveBeenCalledWith(1);
  });

  it("closes the pool even when shutdownAllSessions rejects", async () => {
    shutdownAllSessionsMock.mockRejectedValue(new Error("session teardown exploded"));

    await handler();

    // closePool should still have been called (best-effort)
    expect(closePoolMock).toHaveBeenCalled();
    // process.exit(0) on overall success after handling the error
    expect(processExitMock).toHaveBeenCalledWith(0);
  });
});

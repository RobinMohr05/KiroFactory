/**
 * Tests for WebSocket ping/pong heartbeat in worker-ws-handler.ts (task #1827).
 *
 * Before this fix, the /internal/worker WebSocket connection had no heartbeat.
 * If a worker's TCP connection went dark (WSL VM reset, OOM-kill, Docker
 * daemon restart) without sending a clean FIN/RST, the orchestrator's
 * `isWorkerConnected()` would return true and the session/task would stay
 * stuck forever. The ping/pong heartbeat detects this within a bounded
 * timeout and triggers `onWorkerExited("disconnected")`, the same path that
 * a clean disconnect follows.
 *
 * Tests exercise the heartbeat logic exported from worker-ws-handler.ts via
 * a test-only helper (`_heartbeatForTest`) to avoid coupling the test to
 * the full WebSocket stack.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Minimal WebSocket stub for testing
// ---------------------------------------------------------------------------

/**
 * Minimal stub that mimics the ws.WebSocket API surface used by
 * the heartbeat: .ping(), .terminate(), and event emitter methods.
 */
class WsStub extends EventEmitter {
  public readyState = 1; // WebSocket.OPEN
  public send = vi.fn();
  public ping = vi.fn();
  public close = vi.fn();
  public terminate = vi.fn();
}

// ---------------------------------------------------------------------------
// Test helper for heartbeat logic
// ---------------------------------------------------------------------------

import {
  _heartbeatForTest,
} from "../worker-ws-handler.js";

describe("worker WS heartbeat (ping/pong)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("_heartbeatForTest is exported from worker-ws-handler", () => {
    expect(typeof _heartbeatForTest).toBe("function");
  });

  it("sends a ping to the worker after the heartbeat interval", async () => {
    vi.useFakeTimers();

    const ws = new WsStub();
    const onDead = vi.fn();
    const INTERVAL_MS = 1000;
    const TIMEOUT_MS = 500;

    const handle = _heartbeatForTest(ws as any, onDead, INTERVAL_MS, TIMEOUT_MS);

    expect(ws.ping).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS + 10);

    expect(ws.ping).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it("does NOT call onDead if a pong is received before the timeout", async () => {
    vi.useFakeTimers();

    const ws = new WsStub();
    const onDead = vi.fn();
    const INTERVAL_MS = 1000;
    const TIMEOUT_MS = 500;

    const handle = _heartbeatForTest(ws as any, onDead, INTERVAL_MS, TIMEOUT_MS);

    // Advance to the point where the ping was sent
    await vi.advanceTimersByTimeAsync(INTERVAL_MS + 10);
    expect(ws.ping).toHaveBeenCalledTimes(1);

    // Simulate a pong response arriving before the timeout
    ws.emit("pong");

    // Advance past the timeout — onDead must NOT be called
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 10);

    expect(onDead).not.toHaveBeenCalled();

    handle.stop();
  });

  it("calls onDead if no pong is received within the timeout", async () => {
    vi.useFakeTimers();

    const ws = new WsStub();
    const onDead = vi.fn();
    const INTERVAL_MS = 1000;
    const TIMEOUT_MS = 500;

    const handle = _heartbeatForTest(ws as any, onDead, INTERVAL_MS, TIMEOUT_MS);

    // Advance past interval + timeout without a pong
    await vi.advanceTimersByTimeAsync(INTERVAL_MS + TIMEOUT_MS + 20);

    expect(onDead).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it("terminates the connection when the heartbeat times out", async () => {
    vi.useFakeTimers();

    const ws = new WsStub();
    const onDead = vi.fn();
    const INTERVAL_MS = 1000;
    const TIMEOUT_MS = 500;

    _heartbeatForTest(ws as any, onDead, INTERVAL_MS, TIMEOUT_MS);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS + TIMEOUT_MS + 20);

    // The connection must be terminated (not just closed) so any buffered
    // frames don't hang waiting for acknowledgment from a dead peer.
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels the heartbeat so no further pings or dead callbacks fire", async () => {
    vi.useFakeTimers();

    const ws = new WsStub();
    const onDead = vi.fn();
    const INTERVAL_MS = 1000;
    const TIMEOUT_MS = 500;

    const handle = _heartbeatForTest(ws as any, onDead, INTERVAL_MS, TIMEOUT_MS);

    // Stop before any ping fires
    handle.stop();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS + TIMEOUT_MS + 20);

    expect(ws.ping).not.toHaveBeenCalled();
    expect(onDead).not.toHaveBeenCalled();
  });
});

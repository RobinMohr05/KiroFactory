/**
 * Graceful shutdown handler factory (task #2013).
 *
 * Extracted from index.ts so the logic can be unit-tested without spinning up
 * the full HTTP server. index.ts calls createShutdownHandler() and registers
 * the returned function on SIGINT/SIGTERM.
 *
 * Shutdown order per coding_guidelines.MD §19 ("Graceful Shutdown"):
 *   1. Stop accepting new connections (server.close).
 *   2. Drain in-flight async work (shutdownAllSessions, plannerShutdown).
 *   3. Close DB connections (closePool).
 *   4. Exit.
 *
 * Additional guardrails also required by §19 / task #2013:
 *   - A maximum shutdown timeout (~30s in production) that force-exits
 *     with process.exit(1) if exceeded. The timer is unref()'d so it
 *     doesn't keep the event loop alive on its own.
 *   - An idempotency flag so double-SIGTERM is a no-op.
 */

export interface ShutdownDeps {
  /** Close the HTTP server (stop accepting new connections). */
  serverClose: () => void;
  /** Tear down all active agent sessions. */
  shutdownAllSessions: () => Promise<void>;
  /** Shut down the AI Task Planner session pool. */
  plannerShutdown: () => Promise<void>;
  /** Close the Neo4j connection pool. */
  closePool: () => Promise<void>;
  /** Override for process.exit — injectable for testing. */
  processExit?: (code: number) => void;
  /** Maximum time (ms) to wait for teardown before force-exiting. Default 30_000. */
  timeoutMs?: number;
}

/**
 * Returns a shutdown() function suitable for registering on SIGINT/SIGTERM.
 *
 * The returned function is idempotent: the second (and subsequent) invocations
 * are silent no-ops, so a double-SIGTERM (common in container environments)
 * doesn't attempt teardown twice.
 */
export function createShutdownHandler(deps: ShutdownDeps): () => Promise<void> {
  const {
    serverClose,
    shutdownAllSessions,
    plannerShutdown,
    closePool,
    processExit = (code) => process.exit(code),
    timeoutMs = 30_000,
  } = deps;

  let shuttingDown = false;

  return async function shutdown(): Promise<void> {
    // Idempotency guard — double-SIGTERM is a no-op.
    if (shuttingDown) return;
    shuttingDown = true;

    // 1. Stop accepting new connections immediately.
    serverClose();

    // 2–3. Race the async teardown steps against a hard timeout.
    const teardown = async (): Promise<void> => {
      try {
        await shutdownAllSessions();
      } catch {
        // Session teardown errors are non-fatal — log was already emitted
        // inside shutdownAllSessions; continue to close remaining resources.
      }

      try {
        await plannerShutdown();
      } catch {
        // Planner pool errors are non-fatal.
      }

      try {
        await closePool();
      } catch {
        // Pool may not be connected — not fatal.
      }
    };

    const timeout = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
      // Don't let the timer prevent the process from exiting on its own.
      if (typeof timer.unref === "function") timer.unref();
    });

    const result = await Promise.race([teardown().then(() => "done" as const), timeout]);

    if (result === "timeout") {
      // 4a. Force-exit — ACA will SIGKILL anyway; at least we exit cleanly.
      processExit(1);
    } else {
      // 4b. Clean exit.
      processExit(0);
    }
  };
}

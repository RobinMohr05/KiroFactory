import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Backend workspace root (the directory that holds eslint.config.mjs / tsconfig.json).
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Guardrail test for coding_guidelines.MD §21/§25: the async-safety rule
 * `@typescript-eslint/no-floating-promises` must actually catch fire-and-forget
 * promises in the WebSocket handler. The `ws.on("message", ...)` listener
 * dispatches to the async `handleClientMessage(...)`; if that call is not
 * awaited/voided it is a floating promise — exactly the class of AI-generated
 * async bug the lint gate exists to stop. This test lints the real source file
 * through ESLint's API so it fails if the violation is ever reintroduced.
 */
describe("websocket-handler no-floating-promises", () => {
  it("has no @typescript-eslint/no-floating-promises violations", async () => {
    const eslint = new ESLint({ cwd: backendRoot });
    const results = await eslint.lintFiles(["src/websocket-handler.ts"]);

    const floating = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === "@typescript-eslint/no-floating-promises")
        .map((m) => `${r.filePath}:${m.line} ${m.message}`)
    );

    expect(floating).toEqual([]);
  }, 60_000);
});

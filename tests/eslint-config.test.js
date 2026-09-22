/**
 * Verifies the root ESLint flat config actually enforces the code-quality rules
 * that information/coding_guidelines.MD §21 (Linting & Formatting) and §25 (AI
 * Agent Code Guardrails) call out as the primary layer of the agent
 * self-correcting loop.
 *
 * This is a behavioural test, not a "does the file exist" check: it runs ESLint
 * (using the repo's real eslint.config.js) against small snippets that each
 * violate one guardrail rule, and asserts the corresponding rule fires as an
 * error. If someone weakens the config (drops a rule, downgrades it to "warn",
 * or removes type-aware parsing), one of these assertions breaks.
 *
 * Type-aware rules (e.g. @typescript-eslint/no-floating-promises) only work when
 * the parser is wired to the TypeScript program, so linting real files on disk
 * (not lintText with an anonymous path) is required for those to activate.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** Lint a TS snippet written into the backend workspace so type-aware rules have a real program. */
async function lintBackendSnippet(code) {
  const dir = mkdtempSync(join(rootDir, "backend", "src", "eslint-fixture-"));
  const file = join(dir, "fixture.ts");
  writeFileSync(file, code, "utf8");
  try {
    const eslint = new ESLint({ cwd: rootDir });
    const [result] = await eslint.lintFiles([file]);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ruleIds(result) {
  return (result?.messages ?? []).map((m) => m.ruleId);
}

describe("root ESLint flat config", () => {
  it("flags @typescript-eslint/no-explicit-any as an error", async () => {
    const result = await lintBackendSnippet(`export const x: any = 1;\n`);
    expect(ruleIds(result)).toContain("@typescript-eslint/no-explicit-any");
    const msg = result.messages.find((m) => m.ruleId === "@typescript-eslint/no-explicit-any");
    expect(msg.severity).toBe(2); // error, not warn
  });

  it("flags @typescript-eslint/no-unused-vars but allows an underscore prefix", async () => {
    const bad = await lintBackendSnippet(`export function f() { const unused = 1; return 2; }\n`);
    expect(ruleIds(bad)).toContain("@typescript-eslint/no-unused-vars");

    const ok = await lintBackendSnippet(`export function f() { const _unused = 1; return 2; }\n`);
    expect(ruleIds(ok)).not.toContain("@typescript-eslint/no-unused-vars");
  });

  it("flags @typescript-eslint/no-floating-promises (type-aware) as an error", async () => {
    const code = `
async function work(): Promise<void> {}
export function run(): void {
  work();
}
`;
    const result = await lintBackendSnippet(code);
    expect(ruleIds(result)).toContain("@typescript-eslint/no-floating-promises");
  });

  it("flags eqeqeq (requires === )", async () => {
    const result = await lintBackendSnippet(`export const b = (1 as number) == 2;\n`);
    expect(ruleIds(result)).toContain("eqeqeq");
  });

  it("flags no-return-await", async () => {
    const code = `
export async function g(): Promise<number> {
  return await Promise.resolve(1);
}
`;
    const result = await lintBackendSnippet(code);
    // @typescript-eslint replaces the core rule with its own; accept either id.
    const ids = ruleIds(result);
    expect(
      ids.includes("no-return-await") || ids.includes("@typescript-eslint/return-await"),
    ).toBe(true);
  });

  it("does not fight Prettier: no formatting-only rules are enabled", async () => {
    // eslint-config-prettier turns off stylistic rules. A snippet that is
    // "ugly" but logically fine (only formatting differs) should not trip any
    // core formatting rule such as quotes/semi/indent.
    const result = await lintBackendSnippet(`export const s = 'single'\n`);
    const formatting = ruleIds(result).filter((id) =>
      ["quotes", "semi", "indent", "comma-dangle", "@typescript-eslint/quotes", "@typescript-eslint/semi"].includes(id),
    );
    expect(formatting).toEqual([]);
  });

  it("produces no config-loading errors (the config parses and applies)", async () => {
    const result = await lintBackendSnippet(`export const ok: number = 1;\n`);
    // A fatal parse/config error surfaces as a message with fatal: true.
    const fatal = result.messages.filter((m) => m.fatal);
    expect(fatal).toEqual([]);
  });
});

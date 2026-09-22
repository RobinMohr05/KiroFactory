/**
 * Tests for the Layer 1 pre-commit guardrail stack (coding_guidelines §25).
 *
 * KiroFactory's autonomous agents commit code and respect git hooks — a rejected
 * commit is what makes the agent see the error, fix it, and retry BEFORE a PR is
 * opened. §25 calls this "the difference between a working pipeline and cascading
 * broken PRs." This test verifies the guardrail layer is actually wired:
 *
 * 1. Prettier is installed (with eslint-config-prettier so it doesn't fight ESLint)
 *    and a Prettier config file exists at the repo root.
 * 2. husky + lint-staged + commitlint are installed as root dev dependencies.
 * 3. A `prepare` script installs husky hooks on `npm install`.
 * 4. A lint-staged config runs Prettier and `tsc --noEmit` on staged files.
 * 5. A commitlint config extends @commitlint/config-conventional (§3 Conventional Commits).
 * 6. The .husky/ pre-commit hook runs lint-staged.
 * 7. The .husky/ commit-msg hook runs commitlint.
 * 8. All new dependency versions are pinned exactly (no ^ or ~) per §8.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// backend/src/tests -> repo root is four levels up.
const repoRoot = resolve(__dirname, "..", "..", "..");

function readJson(relPath: string): Record<string, unknown> {
  const full = resolve(repoRoot, relPath);
  return JSON.parse(readFileSync(full, "utf8"));
}

function readText(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), "utf8");
}

const rootPkg = readJson("package.json");
const devDeps = (rootPkg.devDependencies ?? {}) as Record<string, string>;
const scripts = (rootPkg.scripts ?? {}) as Record<string, string>;

const GUARDRAIL_DEV_DEPS = [
  "prettier",
  "eslint-config-prettier",
  "husky",
  "lint-staged",
  "@commitlint/cli",
  "@commitlint/config-conventional",
];

describe("Layer 1 pre-commit guardrail stack (coding_guidelines §25)", () => {
  describe("root package.json dev dependencies", () => {
    it.each(GUARDRAIL_DEV_DEPS)("declares %s as a dev dependency", (dep) => {
      expect(devDeps[dep]).toBeDefined();
    });

    it("pins every guardrail dependency to an exact version (no ^ or ~) per §8", () => {
      for (const dep of GUARDRAIL_DEV_DEPS) {
        const version = devDeps[dep];
        expect(version, `${dep} must be declared`).toBeDefined();
        expect(
          /^[0-9]/.test(version),
          `${dep} version "${version}" must be pinned exactly (no ^ or ~)`,
        ).toBe(true);
      }
    });
  });

  describe("prepare script installs husky", () => {
    it("has a prepare script that runs husky", () => {
      expect(scripts.prepare).toBeDefined();
      expect(scripts.prepare).toMatch(/husky/);
    });

    // The production Docker stage runs `npm ci --omit=dev`, which does NOT install
    // husky (a devDependency) but STILL executes the `prepare` lifecycle script.
    // A bare `husky` invocation there fails with "command not found", exiting
    // non-zero and breaking `docker build`. The prepare script must therefore
    // tolerate husky being absent (e.g. `husky || true`) so it's a no-op in
    // production/CI installs.
    it("is a no-op when husky is unavailable (production/CI safe)", () => {
      expect(scripts.prepare).toBeDefined();
      expect(
        /\|\|\s*true\b/.test(scripts.prepare),
        `prepare script "${scripts.prepare}" must not fail when husky is absent ` +
          `(e.g. "husky || true") — otherwise "npm ci --omit=dev" breaks the ` +
          `production Docker build`,
      ).toBe(true);
    });
  });

  describe("Prettier config", () => {
    it("has a Prettier config file at the repo root", () => {
      const candidates = [
        ".prettierrc",
        ".prettierrc.json",
        ".prettierrc.js",
        ".prettierrc.cjs",
        "prettier.config.js",
        "prettier.config.cjs",
      ];
      const found = candidates.some((c) => existsSync(resolve(repoRoot, c)));
      expect(found, "expected a Prettier config file at the repo root").toBe(true);
    });
  });

  describe("lint-staged config", () => {
    it("runs Prettier and tsc --noEmit on staged files", () => {
      const candidates = [
        ".lintstagedrc",
        ".lintstagedrc.json",
        ".lintstagedrc.js",
        ".lintstagedrc.cjs",
      ];
      const path = candidates.find((c) => existsSync(resolve(repoRoot, c)));
      expect(path, "expected a lint-staged config at the repo root").toBeDefined();
      const raw = readText(path as string);
      expect(raw).toMatch(/prettier/);
      expect(raw).toMatch(/tsc --noEmit|--noEmit/);
    });
  });

  describe("commitlint config", () => {
    it("extends @commitlint/config-conventional (§3 Conventional Commits)", () => {
      const candidates = [
        "commitlint.config.js",
        "commitlint.config.cjs",
        "commitlint.config.mjs",
        ".commitlintrc.json",
      ];
      const path = candidates.find((c) => existsSync(resolve(repoRoot, c)));
      expect(path, "expected a commitlint config at the repo root").toBeDefined();
      const raw = readText(path as string);
      expect(raw).toMatch(/@commitlint\/config-conventional/);
    });
  });

  describe("husky hooks", () => {
    it("has a pre-commit hook that runs lint-staged", () => {
      const hookPath = resolve(repoRoot, ".husky", "pre-commit");
      expect(existsSync(hookPath), "expected .husky/pre-commit to exist").toBe(true);
      expect(readText(".husky/pre-commit")).toMatch(/lint-staged/);
    });

    it("has a commit-msg hook that runs commitlint", () => {
      const hookPath = resolve(repoRoot, ".husky", "commit-msg");
      expect(existsSync(hookPath), "expected .husky/commit-msg to exist").toBe(true);
      expect(readText(".husky/commit-msg")).toMatch(/commitlint/);
    });
  });
});

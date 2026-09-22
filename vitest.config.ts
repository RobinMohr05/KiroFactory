import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.{js,ts}"],
    // Type-aware ESLint runs spin up a TypeScript program on first lint, which
    // can take several seconds; give these integration-style tests headroom.
    testTimeout: 30000,
  },
});

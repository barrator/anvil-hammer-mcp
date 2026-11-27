import { defineConfig } from "vitest/config";

// Live tests hit the real World Anvil API. Manual only; never run in CI.
export default defineConfig({
  test: {
    include: ["live/**/*.live.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});

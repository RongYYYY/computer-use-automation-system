import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Browser tests are intentionally serialized to avoid CPU-induced navigation flakiness in CI.
    fileParallelism: false,
    coverage: {
      reporter: ["text", "json-summary"],
    },
    include: ["tests/**/*.test.ts"],
  },
});

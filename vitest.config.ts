import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        "packages/*/test/**",
        "test/**",
      ],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 65,
        functions: 50,
        lines: 75,
        statements: 75,
      },
    },
    testTimeout: 10_000,
  },
});

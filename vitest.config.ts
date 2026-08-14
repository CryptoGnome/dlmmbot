import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/vitest-setup.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: [
        "src/ranges/**",
        "src/risk/**",
        "src/scanner/gates.ts",
        "src/scanner/score.ts",
        "src/db/db.ts",
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 50,
      },
    },
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 15_000,
  },
});

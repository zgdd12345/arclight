import { defineConfig } from "vitest/config";

// 单元测配置（DEV_PLAN §3.1）：pool=forks，30s timeout。
// 注意：packages/core 下依赖 bun:sqlite / Bun API 的测试用 `bun test` 跑（见 package.json test:core），
// vitest 只覆盖端无关包（protocol / client-core / web）。集成测配置在 slice1 引入。
export default defineConfig({
  test: {
    include: ["packages/protocol/**/*.test.ts", "packages/client-core/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      thresholds: { lines: 70, functions: 70, branches: 60 },
    },
  },
});

import { defineConfig } from "drizzle-kit";

// 从仓库根运行：bun run db:generate（迁移 SQL 落 packages/core/src/db/migrations/）
export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/core/src/db/schema.ts",
  out: "./packages/core/src/db/migrations",
});

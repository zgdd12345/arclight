// @arclight/core — 内核包入口。依赖纪律：不 import 任何端包；provider-adapter（slice2）是唯一 import "ai" 的文件。
export { type ArclightConfig, loadConfig } from "./config/load";
export { createDb, type Db } from "./db/client";
export { runMigrations } from "./db/migrate";
export { serve } from "./serve";
export { type App, type AppDeps, createApp } from "./server/app";
export {
  readServerJson,
  removeServerJson,
  type ServerJson,
  writeServerJson,
} from "./server/serverJson";

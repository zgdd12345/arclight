import { Hono } from "hono";
import type { Db } from "../db/client";
import type { EventBus } from "../events/bus";
import { bearerAuth } from "./middleware/auth";
import { requestContext } from "./middleware/requestContext";
import { createCommandsRoute } from "./routes/commands";
import { createEventsRoute } from "./routes/events";
import { healthRoute } from "./routes/health";
import { createSessionsRoute } from "./routes/sessions";
import { createSnapshotRoute } from "./routes/snapshot";

export type AppDeps = {
  repoPath: string;
  arclightDir: string;
  db: Db;
  bus: EventBus;
  token: string;
  heartbeatMs?: number; // 测试注入
  mockDeltaMs?: number; // 测试注入
};

// Hono app 工厂。/health 开放；/api/* 一律 bearer。
export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.use("*", requestContext);
  app.route("/health", healthRoute);

  const api = new Hono();
  api.use("*", bearerAuth(deps.token));
  api.route(
    "/commands",
    createCommandsRoute({
      db: deps.db,
      bus: deps.bus,
      ...(deps.mockDeltaMs !== undefined ? { mockDeltaMs: deps.mockDeltaMs } : {}),
    }),
  );
  api.route(
    "/sessions",
    createSessionsRoute({ db: deps.db, repoPath: deps.repoPath, arclightDir: deps.arclightDir }),
  );
  api.route(
    "/sessions",
    createEventsRoute({
      db: deps.db,
      bus: deps.bus,
      ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
    }),
  );
  api.route("/sessions", createSnapshotRoute({ db: deps.db }));
  app.route("/api", api);
  return app;
}
export type App = ReturnType<typeof createApp>;

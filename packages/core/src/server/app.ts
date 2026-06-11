import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ApprovalPolicy } from "../approval/policy";
import type { Db } from "../db/client";
import type { EventBus } from "../events/bus";
import type { AgentRunner } from "../loop/runner";
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
  runner?: AgentRunner; // 真实流水线（serve 注入）；缺省走 mock loop（测试）
  approvals?: ApprovalPolicy; // C1 approve 决议入口
  heartbeatMs?: number; // 测试注入
  mockDeltaMs?: number; // 测试注入
};

// Hono app 工厂。/health 开放；/api/* 一律 bearer。
export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.use("*", requestContext);
  // 本地 web dev（next dev :3000）跨域直连内核（D7 无 proxy）；远程拓扑阶段二收紧
  app.use(
    "*",
    cors({
      origin: (o) => (/^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(o) ? o : null),
      allowHeaders: ["authorization", "content-type"],
    }),
  );
  app.route("/health", healthRoute);

  const api = new Hono();
  api.use("*", bearerAuth(deps.token));
  api.route(
    "/commands",
    createCommandsRoute({
      db: deps.db,
      bus: deps.bus,
      ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
      ...(deps.approvals !== undefined ? { approvals: deps.approvals } : {}),
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

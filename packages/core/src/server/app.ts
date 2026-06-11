import { Hono } from "hono";
import { healthRoute } from "./routes/health";

export type AppDeps = {
  // slice1 起注入 db / appendEvent / runner；slice0 仅健康路由
  repoPath: string;
};

// Hono app 工厂：路由挂载点。C1 commands / C2 events SSE / snapshot / artifacts 在 slice1+ 落位。
export function createApp(_deps: AppDeps) {
  const app = new Hono();
  app.route("/health", healthRoute);
  return app;
}
export type App = ReturnType<typeof createApp>;

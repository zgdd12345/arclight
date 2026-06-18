import { dirname } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ApprovalPolicy } from "../approval/policy";
import type { Db } from "../db/client";
import type { EventBus } from "../events/bus";
import type { ProviderManager } from "../loop/provider-manager";
import type { AgentRunner } from "../loop/runner";
import { bearerAuth } from "./middleware/auth";
import { requestContext } from "./middleware/requestContext";
import { createCommandsRoute } from "./routes/commands";
import { createConfigRoute } from "./routes/config";
import { createEventsRoute } from "./routes/events";
import { createFilesRoute } from "./routes/files";
import { createGrantsRoute } from "./routes/grants";
import { healthRoute } from "./routes/health";
import { createMemoriesRoute } from "./routes/memories";
import { createProjectsRoute } from "./routes/projects";
import { createSessionsRoute } from "./routes/sessions";
import { createSnapshotRoute } from "./routes/snapshot";
import { createWorkflowsRoute } from "./routes/workflows";
import type { WorkflowRunner } from "../workflow";
import type { TemplateStore, WorkflowStore } from "../workflow";

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
  devNoAuth?: boolean; // 测试旁路：放行所有鉴权（ARCLIGHT_DEV_NO_AUTH=1）
  projectsRoot?: string; // 项目围栏根（缺省 = repoPath 的父目录）
  providerManager?: ProviderManager; // 模型/thinking 运行时切换（serve 注入；缺省 /api/config 503）
  effectiveWindow?: number; // 上下文压缩窗口（须与 runner 一致；/context-usage 端点据此报余量）
  workflowRunner?: WorkflowRunner; // 动态工作流 HTTP 入口（serve 注入；缺省不挂 /api/workflows）
  workflowStore?: WorkflowStore;
  templateStore?: TemplateStore;
};

/** 私网/回环主机名分类：localhost、127/8 与 ::1 回环、RFC1918（10/8、172.16-31、192.168/16）、
 *  IPv6 ULA fd00::/8（含 RFC4193 与 link-local 之外的私有段）。仅判定 host，端口/协议由调用方处理。 */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost") return true;
  // URL.hostname 对 IPv6 保留方括号，先剥离。
  if (h.startsWith("[") && h.endsWith("]")) {
    const v6 = h.slice(1, -1);
    if (v6 === "::1") return true; // IPv6 回环
    if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true; // ULA fd00::/8（含 fc00::/8）
    return false;
  }
  // IPv4-dotted
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const oct = m.slice(1, 5).map(Number);
  if (oct.some((n) => n > 255)) return false;
  const [a, b] = oct as [number, number, number, number];
  if (a === 127) return true; // 127/8 回环
  if (a === 10) return true; // 10/8
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  return false;
}

/** CORS 来源白名单：解析 Origin 后按 host 分类——localhost / 回环 / RFC1918 私网 /
 *  IPv6 ULA 放行；端口可省略（默认 80/443），公网/任意主机名一律拒绝。 */
export function isAllowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // 真 Origin 无 path/query/credentials；new URL 将其 pathname 归一化为 "/"。
  // 据此拒绝带路径/查询/凭据的伪装来源（如 http://evil.com/10.x.x.x）。
  if (url.pathname !== "/" || url.search !== "" || url.username !== "") return false;
  return isPrivateHost(url.hostname);
}

// Hono app 工厂。/health 开放；/api/* 一律 bearer。
export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.use("*", requestContext);
  // 本地 web dev（next dev :3000）跨域直连内核（D7 无 proxy）；远程拓扑阶段二收紧。
  // 放行范围 = localhost + RFC1918 私网段（10/8、192.168/16、172.16/12）：
  // 配合 ARCLIGHT_HOST=0.0.0.0 支持局域网内其他设备的浏览器直连；公网来源仍拒。
  app.use(
    "*",
    cors({
      origin: (o) => (isAllowedOrigin(o) ? o : null),
      allowHeaders: ["authorization", "content-type"],
    }),
  );
  app.route("/health", healthRoute);

  const api = new Hono();
  api.use("*", bearerAuth(deps.token, deps.devNoAuth));
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
    createSessionsRoute({
      db: deps.db,
      repoPath: deps.repoPath,
      arclightDir: deps.arclightDir,
      ...(deps.effectiveWindow !== undefined ? { effectiveWindow: deps.effectiveWindow } : {}),
    }),
  );
  api.route(
    "/projects",
    createProjectsRoute({
      db: deps.db,
      projectsRoot: deps.projectsRoot ?? dirname(deps.repoPath),
      arclightDir: deps.arclightDir,
    }),
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
  api.route("/sessions", createFilesRoute({ db: deps.db })); // 📎 附件上传
  api.route(
    "/sessions",
    createGrantsRoute(deps.approvals !== undefined ? { approvals: deps.approvals } : {}),
  ); // 审批白名单管理
  api.route("/memories", createMemoriesRoute({ db: deps.db })); // 记忆管理
  if (deps.workflowRunner && deps.workflowStore && deps.templateStore) {
    api.route(
      "/workflows",
      createWorkflowsRoute({
        db: deps.db,
        repoPath: deps.repoPath,
        arclightDir: deps.arclightDir,
        run: deps.workflowRunner,
        store: deps.workflowStore,
        templates: deps.templateStore,
      }),
    );
  }
  api.route(
    "/config",
    createConfigRoute(
      deps.providerManager !== undefined ? { providerManager: deps.providerManager } : {},
    ),
  ); // 供应商/模型
  app.route("/api", api);
  return app;
}
export type App = ReturnType<typeof createApp>;

import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";

// P0 单租户约定（全表带 tenant_id，多租户阶段五再启用）
export type RequestContext = {
  tenantId: "local";
  userId: "local-user";
  requestId: string;
};

declare module "hono" {
  interface ContextVariableMap {
    reqCtx: RequestContext;
  }
}

export const requestContext: MiddlewareHandler = async (c, next) => {
  c.set("reqCtx", { tenantId: "local", userId: "local-user", requestId: randomUUID() });
  await next();
};

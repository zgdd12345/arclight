import { Hono } from "hono";

const startedAt = Date.now();

export const healthRoute = new Hono().get("/", (c) =>
  c.json({
    ok: true,
    service: "arclight-core",
    version: "0.0.1",
    uptimeMs: Date.now() - startedAt,
  }),
);

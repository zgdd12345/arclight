import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

// loopback bearer（P0 拓扑：同源 httpOnly cookie 在 web 接线时补；CLI/测试用 bearer）。
// EventSource 设不了 header 正是前端手写 fetch SSE 的原因之一（D2）。
// devNoAuth=true 时整条鉴权放行（仅供本地测试，由 ARCLIGHT_DEV_NO_AUTH=1 显式开启）。
export function bearerAuth(token: string, devNoAuth = false): MiddlewareHandler {
  const expected = Buffer.from(token);
  return async (c, next) => {
    if (devNoAuth) return next(); // 测试旁路：任意/空 token 放行
    const header = c.req.header("authorization") ?? "";
    const got = header.startsWith("Bearer ") ? header.slice(7) : "";
    const buf = Buffer.from(got);
    const ok = buf.length === expected.length && timingSafeEqual(buf, expected);
    if (!ok) return c.json({ ok: false, code: "UNAUTHORIZED", message: "invalid token" }, 401);
    await next();
  };
}

import { Hono } from "hono";
import type { ApprovalPolicy } from "../../approval/policy";

// 审批白名单可见性（信任面纪律：授权必须可见可撤销）。
// 「本会话允许」过的工具是内存态 grant；这里让用户随时查看并撤销，
// 撤销后该工具的后续调用会重新弹审批。grant 仅 confirm 档，黑名单/高危永不在内。

export function createGrantsRoute(deps: { approvals?: ApprovalPolicy }) {
  const { approvals } = deps;

  return new Hono()
    .get("/:id/grants", (c) => {
      if (!approvals) return c.json({ ok: true, grants: [] }); // mock 拓扑：无策略即无授权
      return c.json({ ok: true, grants: approvals.listGrants(c.req.param("id")) });
    })
    .delete("/:id/grants/:tool", (c) => {
      if (!approvals) return c.json({ ok: false, code: "UNAVAILABLE" }, 503);
      const revoked = approvals.revokeGrant(c.req.param("id"), c.req.param("tool"));
      if (!revoked) return c.json({ ok: false, code: "NOT_FOUND", message: "无此授权" }, 404);
      return c.json({ ok: true });
    });
}

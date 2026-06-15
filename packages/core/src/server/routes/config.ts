import { Hono } from "hono";
import type { ProviderManager } from "../../loop/provider-manager";

// 供应商/模型配置面（仿 ChatGPT 模型切换 + 设置页）。
// 纪律：API key 绝不出现在任何响应里（连掩码都不给，杜绝逐位探测）。

export function createConfigRoute(deps: { providerManager?: ProviderManager }) {
  const { providerManager } = deps;

  return new Hono()
    .get("/", (c) => {
      if (!providerManager) return c.json({ ok: false, code: "UNAVAILABLE" }, 503);
      return c.json({ ok: true, ...providerManager.current() });
    })
    .patch("/", async (c) => {
      if (!providerManager) return c.json({ ok: false, code: "UNAVAILABLE" }, 503);
      const body = (await c.req.json().catch(() => ({}))) as {
        model?: unknown;
        thinking?: unknown;
      };
      const patch: { model?: string; thinking?: boolean } = {};
      if (body.model !== undefined) {
        if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 64) {
          return c.json({ ok: false, code: "VALIDATION", message: "model 非法" }, 400);
        }
        patch.model = body.model.trim();
      }
      if (body.thinking !== undefined) {
        if (typeof body.thinking !== "boolean") {
          return c.json({ ok: false, code: "VALIDATION", message: "thinking 须为布尔" }, 400);
        }
        patch.thinking = body.thinking;
      }
      if (patch.model === undefined && patch.thinking === undefined) {
        return c.json({ ok: false, code: "VALIDATION", message: "无可更新字段" }, 400);
      }
      return c.json({ ok: true, ...providerManager.update(patch) });
    });
}

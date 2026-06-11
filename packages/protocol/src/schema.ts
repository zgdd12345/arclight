import { type ArcCommand, ArcCommandSchema } from "./commands";
import { type ArcEvent, ArcEventSchema } from "./events";

// 解析助手：边界处统一入口（HTTP handler / SSE 消费端用）。
// 失败返回 null + issues，不 throw——调用方决定如何编码错误（C1 → ArcAck VALIDATION）。

export function parseArcCommand(
  input: unknown,
): { ok: true; value: ArcCommand } | { ok: false; issues: string[] } {
  const r = ArcCommandSchema.safeParse(input);
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}

export function parseArcEvent(
  input: unknown,
): { ok: true; value: ArcEvent } | { ok: false; issues: string[] } {
  const r = ArcEventSchema.safeParse(input);
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}

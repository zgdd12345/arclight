import { type ArcCommand, ArcCommandSchema } from "./commands";
import { type ArcEvent, ArcEventSchema, WireEventEnvelopeSchema } from "./events";

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

// 宽容版（SSE 消费端用，"未知 t 静默忽略" 纪律的解析入口）：
// 已知 t → 严格 union 校验；未知 t 但 base 信封合法 → 放行（known:false，由 reducer 忽略，
// 但 seq/epoch 照常推进）；两者皆不合法才算坏帧。
export function parseWireEvent(
  input: unknown,
): { ok: true; value: ArcEvent; known: boolean } | { ok: false; issues: string[] } {
  const r = ArcEventSchema.safeParse(input);
  if (r.success) return { ok: true, value: r.data, known: true };
  const env = WireEventEnvelopeSchema.safeParse(input);
  if (env.success) {
    // 未知事件只承诺 base 信封形状；reducer 侧按 WireEvent 宽容处理
    return { ok: true, value: env.data as unknown as ArcEvent, known: false };
  }
  return { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}

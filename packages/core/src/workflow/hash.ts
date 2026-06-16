import { createHash } from "node:crypto";

/** 规范化 JSON：递归按 key 排序（数组顺序保留），消除键序差异。
 *  resume 缓存命中依赖此稳定性——裸 JSON.stringify 受键序影响会静默丢失前缀命中。*/
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortDeep(src[key]);
    return out;
  }
  return value;
}

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** 脚本源指纹：run 级 resume 主键之一（配 argsHash）。 */
export function scriptHash(source: string): string {
  return sha256Hex(source);
}

/** 启动入参指纹：配 scriptHash 唯一确定一次可 resume 的逻辑 run。 */
export function argsHash(args: unknown): string {
  return sha256Hex(canonicalJson(args));
}

/** 单次原语调用的规格指纹：workflow_agents.specHash，逐调用缓存命中键。 */
export function specHash(spec: unknown): string {
  return sha256Hex(canonicalJson(spec));
}

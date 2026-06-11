/** JSON 预览截断：不可序列化值（循环引用/BigInt）回退到 String，绝不抛。
 *  唯一实现——loop 的 tool.requested argsPreview 与 approval 的 tool_calls argsPreview 共用。 */
export function previewJson(value: unknown, max = 200): string {
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

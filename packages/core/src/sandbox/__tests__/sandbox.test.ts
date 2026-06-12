// 沙箱层回归测试：collectCapped 多字节截断 + killWithEscalation 升级行为。
import { describe, expect, test } from "bun:test";
import { collectCapped } from "../collect";
import { killWithEscalation } from "../killEscalation";

// --- 工具：将字符串数组构造为 ReadableStream<Uint8Array> ---
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

// ================================================================
// collectCapped：UTF-8 字节计量回归
// ================================================================
describe("collectCapped — ASCII", () => {
  test("完整收集时不截断", async () => {
    const { text, truncated } = await collectCapped(makeStream(["hello"]), 100);
    expect(text).toBe("hello");
    expect(truncated).toBe(false);
  });

  test("超限时 truncated=true 且字节数 ≤ cap", async () => {
    const cap = 5;
    const { text, truncated } = await collectCapped(makeStream(["hello world"]), cap);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(cap);
    expect(truncated).toBe(true);
    expect(text).toBe("hello");
  });

  test("多 chunk 累积不超限", async () => {
    const cap = 8;
    const { text, truncated } = await collectCapped(makeStream(["hello", " ", "world"]), cap);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(cap);
    // "hello wo" = 8 bytes（正好切在 ASCII 边界）
    expect(truncated).toBe(true);
  });
});

describe("collectCapped — CJK 多字节", () => {
  test("中文不超 cap 时完整保留且不截断", async () => {
    // "你好" = 6 bytes（3×2），cap=6 → 完整收录
    const { text, truncated } = await collectCapped(makeStream(["你好"]), 6);
    expect(text).toBe("你好");
    expect(truncated).toBe(false);
    expect(Buffer.byteLength(text)).toBe(6);
  });

  test("中文超限时 Buffer.byteLength ≤ cap 且 truncated=true", async () => {
    // "你好世界" = 12 bytes，cap=10 → 只能容纳 3 个字符 (9 bytes)
    const cap = 10;
    const { text, truncated } = await collectCapped(makeStream(["你好世界"]), cap);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(cap);
    expect(truncated).toBe(true);
    // 结果不含 U+FFFD（截断点剔除了残缺序列）
    expect(text).not.toContain("�");
  });

  test("cap 恰好落在多字节序列中间时不输出 U+FFFD", async () => {
    // "测" = 3 bytes [0xE6,0xB5,0x8B]；cap=2 切在序列中间
    const cap = 2;
    const { text, truncated } = await collectCapped(makeStream(["测"]), cap);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(cap);
    expect(truncated).toBe(true);
    expect(text).not.toContain("�");
  });

  test("多 chunk 累积字节数始终 ≤ cap", async () => {
    // 每个 chunk "测"（3 bytes），共 3 个 → 9 bytes；cap=7 → 最多 2 个字符（6 bytes）
    const cap = 7;
    const { text, truncated } = await collectCapped(makeStream(["测", "测", "测"]), cap);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(cap);
    expect(truncated).toBe(true);
    expect(text).not.toContain("�");
  });

  test("混合 ASCII+CJK：字节预算正确消耗", async () => {
    // "AB你好" = 2 + 6 = 8 bytes；cap=5 → "AB你" 只有 5 bytes 但 "你" 需 3 bytes（2+3=5 ≤ 5）
    const cap = 5;
    const { text, truncated } = await collectCapped(makeStream(["AB你好"]), cap);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(cap);
    expect(truncated).toBe(true);
    expect(text).not.toContain("�");
  });
});

// ================================================================
// killWithEscalation：SIGTERM 被忽略时 SIGKILL 在 grace 期后生效
// ================================================================
describe("killWithEscalation", () => {
  test("SIGTERM 被进程忽略时 SIGKILL 在 ~2s 内终止进程（不永久挂起）", async () => {
    // sh -c 'trap "" TERM; sleep 30' 屏蔽 SIGTERM，只有 SIGKILL 能杀掉它
    const proc = Bun.spawn(["sh", "-c", 'trap "" TERM; sleep 30'], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const t0 = Date.now();
    killWithEscalation(proc);
    await proc.exited;
    const elapsed = Date.now() - t0;
    // grace=2s，加 2s 余量共 4s；若超过则说明升级未生效
    expect(elapsed).toBeLessThan(4000);
  }, 8000 /* jest/bun 测试超时 8s */);

  test("进程正常响应 SIGTERM 时不触发 SIGKILL（stray timer 被清理）", async () => {
    // 正常退出进程：SIGTERM 之后 sh 立即退出，定时器应被 finally 取消
    const proc = Bun.spawn(["sh", "-c", "sleep 30"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const t0 = Date.now();
    killWithEscalation(proc);
    await proc.exited;
    const elapsed = Date.now() - t0;
    // 正常响应 SIGTERM 应远快于 grace period
    expect(elapsed).toBeLessThan(1500);
  }, 5000);
});

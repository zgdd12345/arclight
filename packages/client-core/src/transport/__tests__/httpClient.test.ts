// HttpClient 回归测试：默认 fetch 必须以全局调用，不能带实例 this。
// 浏览器（Chrome）对 WebIDL 方法做 this 校验：`this.fetchImpl(...)` 若直接存裸 fetch，
// this 变成 HttpClient 实例 → "Failed to execute 'fetch' on 'Window': Illegal invocation"。
// Bun/Node 的 fetch 不校验 this，故用 this 敏感桩模拟浏览器语义钉死该回归。

import { afterEach, describe, expect, it } from "vitest";
import { HttpClient } from "../httpClient";

describe("HttpClient 默认 fetch 的 this 绑定（浏览器 Illegal invocation 回归）", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("默认路径：fetch 以 this=undefined/globalThis 调用（模拟浏览器校验不抛）", async () => {
    // 模拟 Chrome：this 既非 undefined 也非 globalThis 时抛 Illegal invocation
    globalThis.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      void args;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    } as typeof fetch;

    const http = new HttpClient({ baseUrl: "http://127.0.0.1:43127", token: "t" });
    // 修复前：this.fetchImpl 直接存裸 fetch，方法调用带实例 this → 此处抛 TypeError
    const { status, body } = await http.postJson<{ ok: boolean }>("/api/sessions", {});
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    await expect(http.getJson<{ ok: boolean }>("/health")).resolves.toEqual({ ok: true });
    await expect(http.getRaw("/health")).resolves.toBeInstanceOf(Response);
  });

  it("显式 fetchImpl 注入不受包装影响（测试桩照常生效）", async () => {
    let seenUrl = "";
    const http = new HttpClient({
      baseUrl: "http://x",
      token: "t",
      fetchImpl: ((input: string | URL | Request) => {
        seenUrl = String(input);
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });
    await http.getRaw("/p");
    expect(seenUrl).toBe("http://x/p");
  });
});

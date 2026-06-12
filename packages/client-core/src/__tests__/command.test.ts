// CommandClient.newId 回归测试：crypto.randomUUID 仅安全上下文（HTTPS/localhost）
// 存在；局域网 http 页面（http://10.x.x.x:3000）里它是 undefined，发指令直接
// TypeError 且被 onNew 吞掉（界面无反应）。钉死 getRandomValues 回退路径。

import type { ArcAck } from "@arclight/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CommandClient } from "../command";
import { HttpClient } from "../transport/httpClient";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeClient(captured: { commandId?: string }): CommandClient {
  const http = new HttpClient({
    baseUrl: "http://x",
    token: "t",
    fetchImpl: ((_input: string | URL | Request, init?: RequestInit) => {
      captured.commandId = (JSON.parse(String(init?.body)) as { commandId: string }).commandId;
      const ack: ArcAck = { ok: true, commandId: captured.commandId } as ArcAck;
      return Promise.resolve(
        new Response(JSON.stringify(ack), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch,
  });
  return new CommandClient(http);
}

describe("CommandClient.newId（非安全上下文回退）", () => {
  const originalRandomUUID = crypto.randomUUID;
  afterEach(() => {
    (crypto as { randomUUID: typeof crypto.randomUUID }).randomUUID = originalRandomUUID;
  });

  it("无 crypto.randomUUID（局域网 http 页面）时仍生成合法 UUIDv4", async () => {
    // 模拟非安全上下文：randomUUID 不存在，getRandomValues 仍可用
    (crypto as { randomUUID?: typeof crypto.randomUUID }).randomUUID =
      undefined as unknown as typeof crypto.randomUUID;

    const captured: { commandId?: string } = {};
    const ack = await makeClient(captured).submit("s1", {
      text: "hi",
      agent: "code",
      baseEpoch: 0,
    });
    expect(ack.ok).toBe(true);
    expect(captured.commandId).toMatch(UUID_V4);
  });

  it("有 crypto.randomUUID 时走原生路径", async () => {
    const captured: { commandId?: string } = {};
    await makeClient(captured).submit("s1", { text: "hi", agent: "code", baseEpoch: 0 });
    expect(captured.commandId).toMatch(UUID_V4);
  });
});

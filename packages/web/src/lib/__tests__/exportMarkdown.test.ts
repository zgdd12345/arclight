import type { ThreadMsg } from "@arclight/client-core";
import { describe, expect, it } from "vitest";
import { exportMarkdown } from "../exportMarkdown";

const META = { sessionId: "abcd1234-rest", exportedAt: 1_700_000_000_000 };

describe("exportMarkdown", () => {
  it("空会话产出含头部的有效文档", () => {
    const md = exportMarkdown([], { ...META, title: null });
    expect(md).toContain("# 会话 abcd1234");
    expect(md).toContain("由 arclight 导出");
    expect(md).toContain("（空会话）");
  });

  it("用户标题优先于 sessionId", () => {
    const md = exportMarkdown([], { ...META, title: "重构登录流程" });
    expect(md).toContain("# 重构登录流程");
  });

  it("还原 user / assistant 文本 + 思考 + 工具调用", () => {
    const messages: ThreadMsg[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "读 package.json" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "thinking", text: "先看依赖" },
          { type: "text", text: "这是一个 monorepo" },
          {
            type: "tool",
            callId: "c1",
            name: "read_file",
            status: "ok",
            argsPreview: '{"path":"package.json"}',
            riskTier: "safe",
            riskClass: "read",
            outputPreview: '{"name":"arclight"}',
            progress: "",
          },
        ],
      },
    ];
    const md = exportMarkdown(messages, { ...META, title: null });
    expect(md).toContain("### 🧑 USER");
    expect(md).toContain("读 package.json");
    expect(md).toContain("### 🤖 AGENT");
    expect(md).toContain("<details>");
    expect(md).toContain("先看依赖");
    expect(md).toContain("这是一个 monorepo");
    expect(md).toContain("**🔧 read_file**");
    expect(md).toContain("`ok`");
    expect(md).toContain("read/safe");
    expect(md).toContain('{"path":"package.json"}');
    expect(md).toContain('{"name":"arclight"}');
  });

  it("输出含 ``` 时升级围栏避免破坏", () => {
    const messages: ThreadMsg[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool",
            callId: "c1",
            name: "bash",
            status: "ok",
            argsPreview: "echo '```'",
            riskTier: "confirm",
            riskClass: "write",
            outputPreview: "```\ncode\n```",
            progress: "",
          },
        ],
      },
    ];
    const md = exportMarkdown(messages, { ...META, title: null });
    expect(md).toContain("````"); // 4 反引号围栏
  });

  it("内容含 4 个反引号时围栏升到 5（不被提前闭合）", () => {
    const messages: ThreadMsg[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool",
            callId: "c1",
            name: "bash",
            status: "ok",
            argsPreview: "x",
            riskTier: "confirm",
            riskClass: "write",
            outputPreview: "````\nnested\n````",
            progress: "",
          },
        ],
      },
    ];
    const md = exportMarkdown(messages, { ...META, title: null });
    expect(md).toContain("`````"); // 5 反引号围栏
    expect(md).not.toMatch(/(^|\n)````\n输出/); // 不会用 4 反引号当输出围栏
  });
});

import type { ThreadMsg } from "@arclight/client-core";

// 对话导出（仿 ChatGPT 导出）：把会话消息树渲染为可读 markdown transcript。
// 纯函数，无 DOM/网络依赖——可单测。还原 user/assistant 文本、思考过程（details 折叠）、
// 工具调用（名/参数/状态/输出）。

function fmtTimestamp(ms: number): string {
  // 固定 UTC 输出，避免依赖运行环境时区导致测试不稳定。
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

function fence(text: string): string {
  // 围栏长度须严格长于内容里最长的连续反引号串（≥3）——否则内容中的 ```` 会提前闭合围栏。
  const runs = text.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}\n${text}\n${ticks}`;
}

function renderMessage(msg: ThreadMsg): string {
  const heading = msg.role === "user" ? "### 🧑 USER" : "### 🤖 AGENT";
  const blocks: string[] = [heading];

  for (const part of msg.parts) {
    if (part.type === "text") {
      if (part.text.trim()) blocks.push(part.text.trim());
    } else if (part.type === "thinking") {
      if (part.text.trim()) {
        blocks.push(`<details>\n<summary>思考过程</summary>\n\n${part.text.trim()}\n\n</details>`);
      }
    } else {
      // tool part
      const args = part.argsPreview?.trim();
      const output = (part.outputPreview || part.progress || "").trim();
      const lines = [
        `**🔧 ${part.name}** · \`${part.status}\` · ${part.riskClass}/${part.riskTier}`,
      ];
      if (args) lines.push(`参数：${fence(args)}`);
      if (output) lines.push(`输出：${fence(output)}`);
      blocks.push(lines.join("\n\n"));
    }
  }

  return blocks.join("\n\n");
}

export type ExportMeta = {
  title?: string | null;
  sessionId: string;
  exportedAt: number;
};

/** 会话 → markdown 字符串。空会话也产出含头部的有效文档。 */
export function exportMarkdown(messages: readonly ThreadMsg[], meta: ExportMeta): string {
  const title = meta.title?.trim() || `会话 ${meta.sessionId.slice(0, 8)}`;
  const header = [
    `# ${title}`,
    "",
    `> 由 arclight 导出 · ${fmtTimestamp(meta.exportedAt)} · session \`${meta.sessionId}\``,
    "",
    "---",
  ].join("\n");

  if (messages.length === 0) {
    return `${header}\n\n_（空会话）_\n`;
  }

  const body = messages.map(renderMessage).join("\n\n---\n\n");
  return `${header}\n\n${body}\n`;
}

/** 浏览器下载：把 markdown 存为 .md 文件。SSR/无 document 时静默返回。 */
export function downloadMarkdown(content: string, filename: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

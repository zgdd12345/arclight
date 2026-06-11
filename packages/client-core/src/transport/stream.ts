// 手写 SSE 解析（D2：EventSource 设不了 Authorization header，故 fetch+ReadableStream）。
// 协议要点：帧以空行结尾；`data:` 可多行（join "\n"）；`:` 开头为注释（心跳）；`id:` = seq。

export type SseFrame = { id?: string; event?: string; data: string };

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void> {
  const decoder = new TextDecoder();
  let buf = "";
  let id: string | undefined;
  let event: string | undefined;
  let dataLines: string[] = [];

  const flush = (): SseFrame | null => {
    if (dataLines.length === 0) {
      id = undefined;
      event = undefined;
      return null; // 纯注释帧（心跳）不产出
    }
    const frame: SseFrame = { data: dataLines.join("\n") };
    if (id !== undefined) frame.id = id;
    if (event !== undefined) frame.event = event;
    id = undefined;
    event = undefined;
    dataLines = [];
    return frame;
  };

  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (line === "") {
        const f = flush();
        if (f) yield f;
        continue;
      }
      if (line.startsWith(":")) continue; // 注释/心跳
      const colon = line.indexOf(":");
      const field = colon >= 0 ? line.slice(0, colon) : line;
      const value = colon >= 0 ? line.slice(colon + 1).replace(/^ /, "") : "";
      if (field === "id") id = value;
      else if (field === "event") event = value;
      else if (field === "data") dataLines.push(value);
      // retry 字段当前忽略（退避策略客户端自管）
    }
  }
  const f = flush();
  if (f) yield f;
}

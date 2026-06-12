// 子进程输出收集（容量封顶 + 进度回调），docker 与 nono 后端共用。
// cap 单位为 UTF-8 字节（与 req.maxOutputBytes / profile.limits.stdoutBytes 对齐）。
// CJK 字符一个字符占 3 字节，用 text.length（UTF-16 码元）量化会使预算被低估 ~3x。
export async function collectCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  onChunk?: (chunk: string) => void,
): Promise<{ text: string; truncated: boolean }> {
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0; // 已累积的 UTF-8 字节数
  let truncated = false;
  for await (const chunk of stream) {
    const s = decoder.decode(chunk, { stream: true });
    onChunk?.(s);
    if (bytes >= cap) {
      truncated = true; // 继续消费流防 backpressure 卡死，只是不再累积
      continue;
    }
    const chunkBytes = Buffer.byteLength(s);
    if (bytes + chunkBytes <= cap) {
      text += s;
      bytes += chunkBytes;
    } else {
      // 部分截断：按字节边界切片
      const remaining = cap - bytes;
      const cut = Buffer.from(s).subarray(0, remaining).toString();
      // 切点恰在多字节序列中间时 toString() 输出 U+FFFD，去掉它保证文本合法
      text += cut.endsWith("�") ? cut.slice(0, -1) : cut;
      bytes = cap;
      truncated = true;
    }
  }
  return { text, truncated };
}

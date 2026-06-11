// 子进程输出收集（容量封顶 + 进度回调），docker 与 nono 后端共用。
export async function collectCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  onChunk?: (chunk: string) => void,
): Promise<{ text: string; truncated: boolean }> {
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  for await (const chunk of stream) {
    const s = decoder.decode(chunk, { stream: true });
    onChunk?.(s);
    if (text.length < cap) {
      text += s.slice(0, cap - text.length);
    } else {
      truncated = true; // 继续消费流防 backpressure 卡死，只是不再累积
    }
  }
  if (text.length >= cap) truncated = true;
  return { text, truncated };
}

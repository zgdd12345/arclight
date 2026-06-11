export type HttpClientOptions = {
  baseUrl: string; // e.g. http://127.0.0.1:43127
  token: string;
  fetchImpl?: typeof fetch;
};

// 薄 fetch 包装：统一 bearer 与 JSON 编解码。前端直连内核，无 proxy 中间层（D7）。
export class HttpClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: HttpClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.opts.token}`, ...extra };
  }

  url(path: string): string {
    return `${this.opts.baseUrl}${path}`;
  }

  async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(this.url(path), { headers: this.headers() });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  async postJson<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const res = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  /** SSE 用：返回原始 Response（调用方解析流与 409） */
  async getRaw(path: string): Promise<Response> {
    return this.fetchImpl(this.url(path), { headers: this.headers() });
  }
}

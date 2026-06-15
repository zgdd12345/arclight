export type HttpClientOptions = {
  baseUrl: string; // e.g. http://127.0.0.1:43127
  token: string;
  fetchImpl?: typeof fetch;
};

// 薄 fetch 包装：统一 bearer 与 JSON 编解码。前端直连内核，无 proxy 中间层（D7）。
export class HttpClient {
  // 类型收窄为纯调用签名：Bun 的 typeof fetch 还带 preconnect 静态属性，包装函数不需要
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  constructor(private readonly opts: HttpClientOptions) {
    // 裸 fetch 存为实例属性后以 this.fetchImpl(...) 调用，浏览器里 this 变成
    // HttpClient 实例 → Chrome 抛 "Illegal invocation"（WebIDL this 校验；
    // Bun/Node 不校验所以测试发现不了）。箭头包装保持全局调用。
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
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

  async patchJson<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const res = await this.fetchImpl(this.url(path), {
      method: "PATCH",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  async deleteJson<T>(path: string): Promise<{ status: number; body: T }> {
    const res = await this.fetchImpl(this.url(path), {
      method: "DELETE",
      headers: this.headers(),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  /** SSE 用：返回原始 Response（调用方解析流与 409） */
  async getRaw(path: string): Promise<Response> {
    return this.fetchImpl(this.url(path), { headers: this.headers() });
  }
}

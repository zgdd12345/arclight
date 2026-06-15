// arcClient 单元测试：localStorage 凭据管理 + createSession null 行为。
// window/localStorage 以轻量 stub 模拟（不依赖 jsdom）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---- localStorage stub（覆盖 window.localStorage）----
const store: Record<string, string> = {};
const mockLS: Storage = {
  getItem: (k: string): string | null => store[k] ?? null,
  setItem: (k: string, v: string): void => {
    store[k] = v;
  },
  removeItem: (k: string): void => {
    delete store[k];
  },
  clear: (): void => {
    for (const k of Object.keys(store)) delete store[k];
  },
  key: (i: number): string | null => Object.keys(store)[i] ?? null,
  get length(): number {
    return Object.keys(store).length;
  },
};

beforeEach(() => {
  mockLS.clear();
  // arcClient の関数は typeof window === "undefined" を先にチェックするため、
  // window を globalThis に向ける。
  // @ts-expect-error
  globalThis.window = globalThis;
  globalThis.localStorage = mockLS;
});

afterEach(() => {
  // @ts-expect-error
  delete globalThis.window;
  // @ts-expect-error
  delete globalThis.localStorage;
});

// 動的 import：stub を設定した後にモジュールを読み込む必要があるため遅延 import を使う。
// vitest は ESM モジュールをキャッシュするが、beforeEach で stub を刷新するので問題なし。
import { clearCreds, createSession, httpErrorStatus, readCreds, writeCreds } from "../arcClient";

// ----------------------------------------------------------------
// clearCreds / readCreds
// ----------------------------------------------------------------

describe("clearCreds", () => {
  it("writeCreds 後に clearCreds すると readCreds が null を返す", () => {
    writeCreds({ origin: "http://127.0.0.1:43127", token: "secret" });
    expect(readCreds()).not.toBeNull();

    clearCreds();
    expect(readCreds()).toBeNull();
  });

  it("origin は localStorage に残る（ConnectPanel の事前入力用）", () => {
    writeCreds({ origin: "http://127.0.0.1:43127", token: "t" });
    clearCreds();
    expect(mockLS.getItem("arclight.origin")).toBe("http://127.0.0.1:43127");
  });

  it("token と activeWorkspace は削除される", () => {
    writeCreds({ origin: "http://127.0.0.1:43127", token: "t" });
    mockLS.setItem("arclight.activeWorkspace", "ws-1");
    clearCreds();
    expect(mockLS.getItem("arclight.token")).toBeNull();
    expect(mockLS.getItem("arclight.activeWorkspace")).toBeNull();
  });

  it("clearCreds 後に writeCreds すると readCreds が非 null を返す（再接続成功）", () => {
    writeCreds({ origin: "http://127.0.0.1:43127", token: "t" });
    clearCreds();
    expect(readCreds()).toBeNull();

    // ユーザーが ConnectPanel で再入力 → writeCreds が needsReauth フラグをクリア
    writeCreds({ origin: "http://127.0.0.1:43127", token: "newtoken" });
    const c = readCreds();
    expect(c).not.toBeNull();
    expect(c?.token).toBe("newtoken");
  });

  it("DEV_NO_AUTH：writeCreds でトークン空文字を書き込んだ後は readCreds が非 null", () => {
    writeCreds({ origin: "http://127.0.0.1:43127", token: "" });
    expect(readCreds()).not.toBeNull();
  });

  it("DEV_NO_AUTH：clearCreds 後に writeCreds(空 token) → readCreds 非 null（再接続可能）", () => {
    writeCreds({ origin: "http://127.0.0.1:43127", token: "" });
    clearCreds();
    expect(readCreds()).toBeNull();

    writeCreds({ origin: "http://127.0.0.1:43127", token: "" });
    expect(readCreds()).not.toBeNull();
  });
});

// ----------------------------------------------------------------
// createSession — {ok: false} 時に null を返すことの確認
// ----------------------------------------------------------------

describe("createSession", () => {
  it("{ok: false} レスポンスで null を返す（401 など）", async () => {
    // fetch stub: 401 + {ok: false}
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: unknown, _init?: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      )) as typeof fetch;

    writeCreds({ origin: "http://127.0.0.1:43127", token: "expired" });
    const id = await createSession("ws-1");
    expect(id).toBeNull();

    globalThis.fetch = originalFetch;
  });

  it("{ok: true, sessionId} レスポンスで sessionId 文字列を返す", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: unknown, _init?: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, sessionId: "sess-abc" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as typeof fetch;

    writeCreds({ origin: "http://127.0.0.1:43127", token: "valid" });
    const id = await createSession("ws-1");
    expect(id).toBe("sess-abc");

    globalThis.fetch = originalFetch;
  });
});

// ----------------------------------------------------------------
// httpErrorStatus
// ----------------------------------------------------------------

describe("httpErrorStatus", () => {
  it("'GET /api/projects -> 401' から 401 を抽出する", () => {
    expect(httpErrorStatus(new Error("GET /api/projects -> 401"))).toBe(401);
  });

  it("'GET /api/projects -> 403' から 403 を抽出する", () => {
    expect(httpErrorStatus(new Error("GET /api/projects -> 403"))).toBe(403);
  });

  it("status を含まない文字列では null を返す", () => {
    expect(httpErrorStatus(new Error("network error"))).toBeNull();
  });

  it("非 Error 値（文字列）も処理できる", () => {
    expect(httpErrorStatus("GET /x -> 500")).toBe(500);
  });
});

"use client";

// ConnectPanel —— 首屏连接面板（DEV_PLAN §1.2 web / 构建项 3）。
// 输入内核 origin + bearer token（从 .arclight/server.json 的 token 字段拷来），
// 存 localStorage；「新建会话」POST /api/sessions 后跳 /chat/[sessionId]。
// 前端直连内核（无 proxy）。

import { HttpClient } from "@arclight/client-core";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DEFAULT_ORIGIN, readOrigin, readToken, writeCreds } from "../../lib/arcClient";

type NewSessionResult = { ok: boolean; sessionId?: string; code?: string; message?: string };

export function ConnectPanel() {
  const router = useRouter();
  const [origin, setOrigin] = useState(DEFAULT_ORIGIN);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(readOrigin());
    setToken(readToken());
  }, []);

  async function newSession() {
    setError(null);
    const o = origin.trim();
    const t = token.trim();
    // token 可留空：内核以 ARCLIGHT_DEV_NO_AUTH=1 启动时鉴权放行（测试用）；
    // 否则空 token 会被内核 401 拒回，错误正常提示。
    if (!o) {
      setError("origin 必填。");
      return;
    }
    writeCreds({ origin: o, token: t });
    setBusy(true);
    try {
      const http = new HttpClient({ baseUrl: o, token: t });
      const { status, body } = await http.postJson<NewSessionResult>("/api/sessions", {});
      if (!body.ok || !body.sessionId) {
        setError(`新建会话失败（${status}）：${body.message ?? body.code ?? "未知错误"}`);
        return;
      }
      router.push(`/chat/${body.sessionId}`);
    } catch (e) {
      setError(`无法连接内核：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-base px-6">
      <div className="w-full max-w-[460px]">
        <div className="mb-8">
          <h1
            className="text-[40px] leading-none text-accent"
            style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}
          >
            arc light
          </h1>
          <p className="mt-3 text-[14px] text-muted">
            连接本地内核。token 从{" "}
            <code className="text-brass" style={{ fontFamily: "var(--font-mono)" }}>
              .arclight/server.json
            </code>{" "}
            的{" "}
            <code className="text-brass" style={{ fontFamily: "var(--font-mono)" }}>
              token
            </code>{" "}
            字段拷取。
          </p>
        </div>

        <div className="space-y-4">
          <Field label="内核 origin">
            <input
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              placeholder={DEFAULT_ORIGIN}
              spellCheck={false}
              className="w-full border bg-surface px-3 py-2 text-[13px] text-text outline-none placeholder:text-muted focus:border-[var(--accent)]"
              style={{ borderColor: "var(--hairline)", fontFamily: "var(--font-mono)" }}
            />
          </Field>

          <Field label="bearer token">
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              placeholder="server.json → token"
              spellCheck={false}
              className="w-full border bg-surface px-3 py-2 text-[13px] text-text outline-none placeholder:text-muted focus:border-[var(--accent)]"
              style={{ borderColor: "var(--hairline)", fontFamily: "var(--font-mono)" }}
            />
          </Field>

          {error ? (
            <p className="text-[12px] text-accent-hot" style={{ fontFamily: "var(--font-mono)" }}>
              {error}
            </p>
          ) : null}

          <button
            type="button"
            onClick={newSession}
            disabled={busy}
            className="w-full px-4 py-2.5 text-[14px] font-[700] text-base disabled:opacity-50"
            style={{ backgroundColor: "var(--accent)" }}
          >
            {busy ? "建立中…" : "新建会话"}
          </button>
        </div>
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block">
      {/* biome-ignore lint/a11y/noLabelWithoutControl: 关联控件由 children 动态注入，静态分析无法识别 */}
      <label
        className="mb-1.5 block text-[11px] uppercase tracking-wider text-muted"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

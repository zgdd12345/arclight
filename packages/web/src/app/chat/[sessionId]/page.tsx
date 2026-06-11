"use client";

// chat 页（DEV_PLAN §1.2）：客户端直连内核。
// 构造 client-core 连接 → bootstrap snapshot（刷新不丢）→ 连 SSE；
// 经 ArcRuntimeProvider 把 SessionStore 接进 assistant-ui ExternalStoreRuntime。

import type { ConnectionStatus } from "@arclight/client-core";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PermissionModal } from "../../../components/approval/PermissionModal";
import { ArcThread } from "../../../components/chat/ArcThread";
import { SessionStatusBar } from "../../../components/session/SessionStatusBar";
import { type ArcConnection, createArcConnection } from "../../../lib/arcClient";
import { ArcRuntimeProvider } from "../../../lib/assistantRuntime";

export default function ChatPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = String(params?.sessionId ?? "");
  const router = useRouter();
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [conn, setConn] = useState<ArcConnection | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const c = createArcConnection(sessionId, setStatus);
    if (!c) {
      router.replace("/"); // 无凭据 → 回连接面板
      return;
    }
    setConn(c);
    void c.bootstrapAndStart();
    return () => c.stream.stop();
  }, [sessionId, router]);

  if (!conn) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-base">
        <span className="text-[13px] text-muted" style={{ fontFamily: "var(--font-mono)" }}>
          连接内核中…
        </span>
      </main>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-base">
      <ArcRuntimeProvider sessionId={sessionId} store={conn.store} command={conn.command}>
        <SessionStatusBar status={status} />
        <ArcThread />
        {/* 断电闸刀：信任面纪律②。挂在 provider 内以读 store.pendingApprovals；command 直传内核审批。 */}
        <PermissionModal command={conn.command} />
      </ArcRuntimeProvider>
    </div>
  );
}

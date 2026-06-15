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
import { ProjectSidebar } from "../../../components/sidebar/ProjectSidebar";
import { type ArcConnection, clearCreds, createArcConnection } from "../../../lib/arcClient";
import { ArcRuntimeProvider } from "../../../lib/assistantRuntime";

export default function ChatPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = String(params?.sessionId ?? "");
  const router = useRouter();
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [conn, setConn] = useState<ArcConnection | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    // token 失效/轮换（SSE 401/403 终态）→ 回连接面板重新填 token，不留死页面
    const c = createArcConnection(sessionId, setStatus, () => {
      clearCreds();
      router.replace("/");
    });
    if (!c) {
      router.replace("/"); // 无凭据 → 回连接面板
      return;
    }
    setConn(c);
    void c.bootstrapAndStart();
    return () => c.stream.stop();
  }, [sessionId, router]);

  // 两栏布局：左 ChatGPT 式侧边栏（项目+历史），右会话主区。侧栏自连内核，连接中也先显示。
  return (
    <div className="flex h-dvh bg-base">
      <ProjectSidebar
        activeSessionId={sessionId}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />
      {!conn ? (
        <main className="flex flex-1 items-center justify-center">
          <span className="text-[13px] text-muted" style={{ fontFamily: "var(--font-mono)" }}>
            连接内核中…
          </span>
        </main>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <ArcRuntimeProvider sessionId={sessionId} store={conn.store} command={conn.command}>
            <SessionStatusBar status={status} onToggleNav={() => setMobileNavOpen(true)} />
            <ArcThread />
            {/* 断电闸刀：信任面纪律②。挂在 provider 内以读 store.pendingApprovals；command 直传内核审批。 */}
            <PermissionModal command={conn.command} />
          </ArcRuntimeProvider>
        </div>
      )}
    </div>
  );
}

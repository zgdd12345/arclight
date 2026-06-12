"use client";

// 首页：未连接 → 连接面板；已连接 → 两栏工作台（左侧边栏管理项目+历史，右空态引导新建/选择会话）。
import { useEffect, useState } from "react";
import { ConnectPanel } from "../components/connect/ConnectPanel";
import { ProjectSidebar } from "../components/sidebar/ProjectSidebar";
import { readCreds } from "../lib/arcClient";

export default function HomePage() {
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    setConnected(readCreds() !== null);
  }, []);

  if (connected === null) return null; // 避免 SSR/CSR 闪烁
  if (!connected) return <ConnectPanel />;

  return (
    <div className="flex h-dvh bg-base">
      <ProjectSidebar />
      <main className="flex flex-1 flex-col items-center justify-center px-6">
        <p className="text-[14px] text-muted">从左侧选择历史会话，或新建会话开始。</p>
      </main>
    </div>
  );
}

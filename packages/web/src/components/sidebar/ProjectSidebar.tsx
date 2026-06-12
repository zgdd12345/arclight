"use client";

// ProjectSidebar —— 仿 ChatGPT 左栏：项目（workspace）管理 + 会话历史。
// 顶部新建会话；项目区可切换/新建（仅 projectsRoot 围栏内）；历史区列当前项目会话，点击恢复。
// 自取凭据直连内核（无凭据则空渲染，由页面引导去连接面板）。DESIGN.md：surface 底、
// hairline 线、panel 激活态、accent 琥珀、border-radius 0、repoPath 用 mono。

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  clearCreds,
  createProject,
  createSession,
  httpErrorStatus,
  listProjects,
  listSessions,
  type Project,
  readActiveWorkspace,
  type SessionMeta,
  writeActiveWorkspace,
} from "../../lib/arcClient";

export function ProjectSidebar({ activeSessionId }: { activeSessionId?: string }) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [available, setAvailable] = useState<{ name: string }[]>([]);
  const [activeWs, setActiveWs] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  // Fix5/6：统一错误面；401 → clearCreds+回连接面板，其他错误 → 显示提示+重连按钮
  const [sidebarError, setSidebarError] = useState<string | null>(null);

  /** 令牌失效的统一恢复路径：清除凭据 → ConnectPanel。 */
  const reconnect = useCallback(() => {
    clearCreds();
    router.push("/");
  }, [router]);

  const refreshProjects = useCallback(async () => {
    try {
      const r = await listProjects();
      if (!r) return;
      setSidebarError(null);
      setProjects(r.projects);
      setAvailable(r.available);
      // 选定活跃项目：localStorage 记忆 → 否则第一个
      const remembered = readActiveWorkspace();
      const pick =
        (remembered && r.projects.find((p) => p.workspaceId === remembered)?.workspaceId) ||
        r.projects[0]?.workspaceId ||
        null;
      setActiveWs(pick);
    } catch (err) {
      // 401/403 → token 失效，立即引导重连；其他错误 → 显示提示
      if (httpErrorStatus(err) === 401 || httpErrorStatus(err) === 403) {
        reconnect();
        return;
      }
      setSidebarError("无法加载项目，检查连接/令牌");
    }
  }, [reconnect]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    if (!activeWs) {
      setSessions([]);
      return;
    }
    writeActiveWorkspace(activeWs);
    void (async () => {
      try {
        const ss = await listSessions(activeWs);
        setSessions(ss);
        setSidebarError(null);
      } catch (err) {
        if (httpErrorStatus(err) === 401 || httpErrorStatus(err) === 403) {
          reconnect();
          return;
        }
        setSidebarError("无法加载项目，检查连接/令牌");
      }
    })();
  }, [activeWs, reconnect]);

  const selectProject = (id: string) => setActiveWs(id);

  const onNewSession = async () => {
    if (!activeWs || busy) return;
    setBusy(true);
    const id = await createSession(activeWs).finally(() => setBusy(false));
    if (id) {
      router.push(`/chat/${id}`);
      return;
    }
    // null → 服务端拒绝（可能 401 token 失效）→ 提示并提供重连入口
    setSidebarError("操作失败，可能令牌失效");
  };

  const onCreateProject = async (name: string) => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    const p = await createProject(n).finally(() => setBusy(false));
    if (p) {
      setSidebarError(null);
      setAdding(false);
      setNewName("");
      await refreshProjects();
      setActiveWs(p.workspaceId);
      return;
    }
    // null → 创建失败（可能 401 token 失效）→ 提示并提供重连入口
    setSidebarError("操作失败，可能令牌失效");
  };

  return (
    <aside
      className="flex h-dvh w-[264px] shrink-0 flex-col border-r bg-surface"
      style={{ borderColor: "var(--hairline)" }}
    >
      {/* 新建会话（顶部主操作） */}
      <div className="p-3">
        <button
          type="button"
          disabled={!activeWs || busy}
          onClick={onNewSession}
          className="flex w-full items-center gap-2 border px-3 py-2 text-[13px] font-[700] text-text disabled:opacity-40"
          style={{ borderColor: "var(--hairline)", fontFamily: "var(--font-mono)" }}
        >
          <span style={{ color: "var(--accent)" }}>＋</span> 新建会话
        </button>
      </div>

      {/* 错误提示区（Fix5/6：网络/鉴权失败时显示，提供重连入口） */}
      {sidebarError ? (
        <div className="px-3 pb-2">
          <p className="text-[11px] text-accent-hot" style={{ fontFamily: "var(--font-mono)" }}>
            {sidebarError}
          </p>
          <button
            type="button"
            onClick={reconnect}
            className="mt-1 text-[11px] text-muted underline"
          >
            重新连接
          </button>
        </div>
      ) : null}

      {/* 项目区 */}
      <div className="px-3 pb-1">
        <div className="flex items-center justify-between py-1">
          <span className="text-[11px] uppercase tracking-wider text-muted">项目</span>
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            className="px-1 text-[14px] leading-none text-muted hover:text-text"
            title="新建项目（仅项目根目录内）"
          >
            ＋
          </button>
        </div>

        {adding ? (
          <div className="mb-2 flex flex-col gap-1">
            {available.length > 0 ? (
              <select
                onChange={(e) => e.target.value && void onCreateProject(e.target.value)}
                defaultValue=""
                className="border bg-base px-2 py-1 text-[12px] text-text"
                style={{ borderColor: "var(--hairline)", fontFamily: "var(--font-mono)" }}
              >
                <option value="" disabled>
                  选择根目录下的文件夹…
                </option>
                {available.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            ) : null}
            <div className="flex gap-1">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void onCreateProject(newName)}
                placeholder="或新建文件夹名…"
                spellCheck={false}
                className="min-w-0 flex-1 border bg-base px-2 py-1 text-[12px] text-text outline-none placeholder:text-muted"
                style={{ borderColor: "var(--hairline)", fontFamily: "var(--font-mono)" }}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void onCreateProject(newName)}
                className="border px-2 py-1 text-[12px] disabled:opacity-40"
                style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
              >
                建
              </button>
            </div>
          </div>
        ) : null}

        <ul className="flex flex-col">
          {projects.map((p) => {
            const active = p.workspaceId === activeWs;
            return (
              <li key={p.workspaceId}>
                <button
                  type="button"
                  onClick={() => selectProject(p.workspaceId)}
                  className="w-full border-l-2 px-2 py-1.5 text-left text-[13px]"
                  style={{
                    borderColor: active ? "var(--accent)" : "transparent",
                    backgroundColor: active ? "var(--panel)" : "transparent",
                    color: active ? "var(--text)" : "var(--muted)",
                  }}
                  title={p.repoPath}
                >
                  {p.name}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* 历史区（当前项目的会话） */}
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="py-1 text-[11px] uppercase tracking-wider text-muted">历史</div>
        {sessions.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-muted">暂无会话</p>
        ) : (
          <ul className="flex flex-col">
            {sessions.map((s) => {
              const active = s.id === activeSessionId;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => router.push(`/chat/${s.id}`)}
                    className="w-full truncate border-l-2 px-2 py-1.5 text-left text-[13px]"
                    style={{
                      borderColor: active ? "var(--accent)" : "transparent",
                      backgroundColor: active ? "var(--panel)" : "transparent",
                      color: active ? "var(--text)" : "var(--muted)",
                    }}
                    title={s.title ?? s.id}
                  >
                    {s.title ?? `会话 ${s.id.slice(0, 8)}`}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

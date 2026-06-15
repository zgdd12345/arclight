"use client";

// ProjectSidebar —— 仿 ChatGPT 左栏：项目（workspace）+ 会话历史的完整增删改查。
// 顶部新建会话；项目/会话行 hover 出现 ✎ 重命名（行内输入）与 ✕ 删除（两步确认）；
// 会话标题由内核在首条提问时自动生成（PATCH 可改）。删除走 fail-closed：
// 活跃 turn 服务端 409 拒绝，提示先停止。侧栏可折叠（仿 ChatGPT，localStorage 记忆）。
// DESIGN.md 修订版：surface 底、柔和 hairline、panel 激活态（圆角 hover）、accent 琥珀、
// 机器产出 mono；删除确认用 accent-hot（hazard 红仅属 Agent 审批面，不稀释）。

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearCreds,
  createProject,
  createSession,
  deleteProject,
  deleteSession,
  httpErrorStatus,
  listProjects,
  listSessions,
  type MutationResult,
  type Project,
  readActiveWorkspace,
  readOrigin,
  renameProject,
  renameSession,
  type SessionMeta,
  writeActiveWorkspace,
} from "../../lib/arcClient";
import { SettingsModal } from "../settings/SettingsModal";

/** 鉴权失败（401/403）：token 失效，需回连接面板重连。 */
function isAuthError(err: unknown): boolean {
  const s = httpErrorStatus(err);
  return s === 401 || s === 403;
}

// ── 行级操作组件：标题按钮 + hover 操作（✎/✕）+ 行内重命名 + 两步删除确认 ──

type RowState = "idle" | "renaming" | "confirmingDelete";

function SidebarRow({
  label,
  title,
  active,
  mono,
  onOpen,
  onRename,
  onDelete,
}: {
  label: string;
  title?: string;
  active: boolean;
  mono?: boolean;
  onOpen: () => void;
  onRename: (name: string) => Promise<MutationResult>;
  onDelete: () => Promise<MutationResult>;
}) {
  const [state, setState] = useState<RowState>("idle");
  const [draft, setDraft] = useState(label);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Escape 取消标记：Escape 卸载 input 会触发 onBlur→commitRename，若不拦截会把已编辑的草稿误存。
  const cancelRef = useRef(false);

  // 重命名/删除共用收尾：setBusy 包裹 + ok/err 分支 + 网络异常兜底（不让 promise 拒绝逃逸成
  // unhandled rejection）。idleOnError：失败时是否退出编辑态——删除失败回 idle，重命名失败留在
  // 编辑态供修正。
  const runMutation = async (
    fn: () => Promise<MutationResult>,
    failMsg: string,
    idleOnError: boolean,
  ) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r.ok) {
        setErr(null);
        setState("idle");
      } else {
        setErr(r.message ?? failMsg);
        if (idleOnError) setState("idle");
      }
    } catch {
      setErr(`${failMsg}（网络异常）`);
      if (idleOnError) setState("idle");
    } finally {
      setBusy(false);
    }
  };

  const commitRename = async () => {
    if (cancelRef.current) {
      cancelRef.current = false; // Escape 取消：跳过本次（blur 触发的）提交
      return;
    }
    const name = draft.trim();
    if (!name || name === label) {
      setState("idle");
      return;
    }
    await runMutation(() => onRename(name), "重命名失败", false);
  };

  const commitDelete = () => runMutation(onDelete, "删除失败", true);

  if (state === "renaming") {
    return (
      <div className="flex items-center gap-1 rounded-md bg-panel px-2 py-1">
        <input
          // biome-ignore lint/a11y/noAutofocus: 行内重命名以键盘流为先，进入即聚焦是预期交互
          autoFocus
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitRename();
            if (e.key === "Escape") {
              cancelRef.current = true; // 标记取消，拦下随后 onBlur 触发的提交
              setState("idle");
            }
          }}
          onBlur={() => void commitRename()}
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-text outline-none"
        />
      </div>
    );
  }

  if (state === "confirmingDelete") {
    return (
      <div className="flex items-center gap-2 rounded-md bg-panel px-2 py-1.5">
        <span className="flex-1 font-mono text-[11px] text-accent-hot">删除？不可恢复</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void commitDelete()}
          className="rounded border border-accent-hot px-1.5 font-mono text-[11px] text-accent-hot disabled:opacity-40"
        >
          删
        </button>
        <button
          type="button"
          onClick={() => setState("idle")}
          className="px-1 font-mono text-[11px] text-muted hover:text-text"
        >
          取消
        </button>
      </div>
    );
  }

  return (
    <div
      className="group flex items-center rounded-md transition-colors duration-100 hover:bg-panel"
      style={{ backgroundColor: active ? "var(--panel)" : undefined }}
    >
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-[13px]"
        style={{
          color: active ? "var(--text)" : "var(--muted)",
          ...(mono ? { fontFamily: "var(--font-mono)" } : {}),
        }}
        title={title ?? label}
      >
        {label}
      </button>
      <div className="hidden shrink-0 items-center pr-1 group-focus-within:flex group-hover:flex">
        <button
          type="button"
          onClick={() => {
            cancelRef.current = false; // 进入编辑前清取消标记
            setDraft(label);
            setState("renaming");
          }}
          className="px-1 font-mono text-[12px] text-muted hover:text-text"
          title="重命名"
        >
          ✎
        </button>
        <button
          type="button"
          onClick={() => setState("confirmingDelete")}
          className="px-1 font-mono text-[12px] text-muted hover:text-accent-hot"
          title="删除"
        >
          ✕
        </button>
      </div>
      {err ? (
        <span className="shrink-0 pr-2 font-mono text-[10px] text-accent-hot" title={err}>
          !
        </span>
      ) : null}
    </div>
  );
}

const COLLAPSED_KEY = "arclight.sidebarCollapsed";

/** 会话搜索过滤（不区分大小写，null title 回退 id）。纯函数，可单测。 */
export function filterSessions<T extends { id: string; title: string | null }>(
  list: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((s) => (s.title ?? `会话 ${s.id.slice(0, 8)}`).toLowerCase().includes(q));
}

export function ProjectSidebar({
  activeSessionId,
  mobileOpen = false,
  onMobileClose,
}: {
  activeSessionId?: string;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  // 折叠态（仿 ChatGPT）：SSR 先展开，挂载后回填 localStorage 记忆
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSED_KEY) === "1");
    } catch {
      // localStorage 不可用：保持展开
    }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, v ? "0" : "1");
      } catch {
        // 仅本次会话生效
      }
      return !v;
    });
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
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
      if (isAuthError(err)) {
        reconnect();
        return;
      }
      setSidebarError("无法加载项目，检查连接/令牌");
    }
  }, [reconnect]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  const refreshSessions = useCallback(async () => {
    if (!activeWs) {
      setSessions([]);
      return;
    }
    try {
      const ss = await listSessions(activeWs);
      setSessions(ss);
      setSidebarError(null);
    } catch (err) {
      if (isAuthError(err)) {
        reconnect();
        return;
      }
      setSidebarError("无法加载会话，检查连接/令牌");
    }
  }, [activeWs, reconnect]);

  // activeSessionId 入 deps：切会话/发首条消息后回焦时拉取自动标题。
  useEffect(() => {
    if (activeWs) writeActiveWorkspace(activeWs);
    void refreshSessions();
  }, [activeWs, refreshSessions]);

  // 窗口回焦刷新：自动标题（首条提问生成）与他端改动不需要手动刷新页面。
  useEffect(() => {
    const onFocus = () => void refreshSessions();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshSessions]);

  const onNewSession = async () => {
    if (!activeWs || busy) return;
    setBusy(true);
    const id = await createSession(activeWs).finally(() => setBusy(false));
    if (id) {
      onMobileClose?.();
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

  const onRenameSession = async (id: string, title: string) => {
    const r = await renameSession(id, title);
    if (r.ok) await refreshSessions();
    return r;
  };

  const onDeleteSession = async (id: string) => {
    const r = await deleteSession(id);
    if (r.ok) {
      await refreshSessions();
      // 删的是当前打开的会话 → 回首页（死页面没有意义）
      if (id === activeSessionId) router.push("/");
    }
    return r;
  };

  const onRenameProject = async (wsId: string, name: string) => {
    const r = await renameProject(wsId, name);
    if (r.ok) await refreshProjects();
    return r;
  };

  const onDeleteProject = async (wsId: string) => {
    const r = await deleteProject(wsId);
    if (r.ok) {
      const wasActive = wsId === activeWs;
      if (wasActive) setActiveWs(null);
      await refreshProjects();
      // 当前打开的会话属于被删项目（级联清除）→ 回首页，不留死页面
      if (wasActive && activeSessionId && sessions.some((s) => s.id === activeSessionId)) {
        router.push("/");
      }
    }
    return r;
  };

  // 当前项目会话按搜索过滤（派生值，记忆化避免无关 state 变化时重算）。
  const filteredSessions = useMemo(() => filterSessions(sessions, search), [sessions, search]);

  // 折叠态窄栏（仿 ChatGPT collapsed rail）：仅桌面（md+）；移动端用抽屉，不折叠。
  const railNode = (
    <aside
      className="hidden h-dvh w-[52px] shrink-0 flex-col items-center gap-1 border-r bg-surface py-3 md:flex"
      style={{ borderColor: "var(--hairline)" }}
    >
      <button
        type="button"
        onClick={toggleCollapsed}
        className="rounded-md p-2 font-mono text-[14px] text-muted hover:bg-panel hover:text-text"
        title="展开侧边栏"
      >
        »
      </button>
      <button
        type="button"
        disabled={!activeWs || busy}
        onClick={onNewSession}
        className="rounded-md p-2 font-mono text-[14px] disabled:opacity-40"
        style={{ color: "var(--accent)" }}
        title="新建会话"
      >
        ＋
      </button>
      <div className="flex-1" />
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        className="rounded-md p-2 font-mono text-[14px] text-muted hover:bg-panel hover:text-text"
        title="设置"
      >
        ⚙
      </button>
    </aside>
  );

  // 全宽侧栏：桌面静态（折叠时 md:hidden 让位 rail）；移动端固定抽屉（mobileOpen 滑入）。
  const fullAside = (
    <aside
      className={`fixed inset-y-0 left-0 z-40 h-dvh w-[264px] shrink-0 flex-col border-r bg-surface transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      } flex ${collapsed ? "md:hidden" : "md:flex"}`}
      style={{ borderColor: "var(--hairline)" }}
    >
      {/* 顶部：折叠开关（桌面）/ 关闭（移动）+ 新建会话 */}
      <div className="flex items-center gap-2 p-3">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="hidden shrink-0 rounded-md p-2 font-mono text-[14px] leading-none text-muted hover:bg-panel hover:text-text md:block"
          title="折叠侧边栏"
        >
          «
        </button>
        <button
          type="button"
          onClick={onMobileClose}
          className="shrink-0 rounded-md p-2 font-mono text-[16px] leading-none text-muted hover:bg-panel hover:text-text md:hidden"
          title="关闭"
          aria-label="关闭侧边栏"
        >
          ✕
        </button>
        <button
          type="button"
          disabled={!activeWs || busy}
          onClick={onNewSession}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-3 py-2 text-[13px] font-[700] text-text hover:bg-panel disabled:opacity-40"
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
                className="rounded-md border bg-base px-2 py-1 text-[12px] text-text"
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
                className="min-w-0 flex-1 rounded-md border bg-base px-2 py-1 text-[12px] text-text outline-none placeholder:text-muted"
                style={{ borderColor: "var(--hairline)", fontFamily: "var(--font-mono)" }}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void onCreateProject(newName)}
                className="rounded-md border px-2 py-1 text-[12px] disabled:opacity-40"
                style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
              >
                建
              </button>
            </div>
          </div>
        ) : null}

        <ul className="flex flex-col">
          {projects.map((p) => (
            <li key={p.workspaceId}>
              <SidebarRow
                label={p.name}
                title={p.repoPath}
                active={p.workspaceId === activeWs}
                onOpen={() => setActiveWs(p.workspaceId)}
                onRename={(name) => onRenameProject(p.workspaceId, name)}
                onDelete={() => onDeleteProject(p.workspaceId)}
              />
            </li>
          ))}
        </ul>
      </div>

      {/* 历史区（当前项目的会话）。标题由内核在首条提问时自动生成。 */}
      <div className="mt-1 flex min-h-0 flex-1 flex-col px-3 pb-3">
        <div className="py-1 text-[11px] uppercase tracking-wider text-muted">历史</div>
        {sessions.length > 0 ? (
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索会话…"
            spellCheck={false}
            className="mb-1 w-full rounded-md border bg-base px-2 py-1 text-[12px] text-text outline-none placeholder:text-muted focus:border-muted"
            style={{ borderColor: "var(--hairline)" }}
          />
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <p className="px-2 py-2 text-[12px] text-muted">暂无会话</p>
          ) : filteredSessions.length === 0 ? (
            <p className="px-2 py-2 text-[12px] text-muted">无匹配会话</p>
          ) : (
            <ul className="flex flex-col">
              {filteredSessions.map((s) => (
                <li key={s.id}>
                  <SidebarRow
                    label={s.title ?? `会话 ${s.id.slice(0, 8)}`}
                    title={s.title ?? s.id}
                    active={s.id === activeSessionId}
                    onOpen={() => {
                      onMobileClose?.();
                      router.push(`/chat/${s.id}`);
                    }}
                    onRename={(title) => onRenameSession(s.id, title)}
                    onDelete={() => onDeleteSession(s.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* 左下角：个人信息 + 设置入口（仿 ChatGPT 账户块） */}
      <div className="border-t border-hairline p-2">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-panel"
          title="个人信息与系统设置"
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-[700]"
            style={{ backgroundColor: "var(--accent)", color: "var(--base)" }}
            aria-hidden
          >
            本
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-text">本地用户</span>
            <span className="block truncate font-mono text-[11px] text-muted">
              {readOrigin().replace(/^https?:\/\//, "")}
            </span>
          </span>
          <span className="shrink-0 font-mono text-[14px] text-muted" aria-hidden>
            ⚙
          </span>
        </button>
      </div>
    </aside>
  );

  return (
    <>
      {collapsed ? railNode : null}
      {/* 移动端抽屉遮罩：点击关闭 */}
      {mobileOpen ? (
        <button
          type="button"
          aria-label="关闭侧边栏"
          onClick={onMobileClose}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      ) : null}
      {fullAside}
      {/* 全局浮层：置于布局容器外，避免折叠态 fullAside 的 md:hidden 把它一起藏掉 */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        sessionId={activeSessionId}
      />
    </>
  );
}

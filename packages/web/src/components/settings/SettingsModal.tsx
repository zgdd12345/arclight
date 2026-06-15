"use client";

// SettingsModal —— 系统设置（仿 ChatGPT 设置弹层）：左 tab 列 + 右内容区。
// 通用（主题/连接）· 模型与供应商（运行时切换 model/thinking）· 记忆管理（增删停用）。
// 视觉：柔和圆角 + hairline；遮罩用普通半透明压暗——压暗降饱和是审批闸刀的专属语言，不挪用。

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  clearCreds,
  createMemory,
  deleteMemory,
  getProviderConfig,
  listGrants,
  listMemories,
  type MemoryItem,
  type ProviderConfig,
  patchProviderConfig,
  readOrigin,
  revokeGrant,
  updateMemory,
} from "../../lib/arcClient";
import { applyTheme } from "../../lib/theme";

type Tab = "general" | "provider" | "memory" | "grants";

const PROVIDER_LABEL: Record<ProviderConfig["provider"], string> = {
  zhipu: "智谱 GLM（Anthropic 兼容端点）",
  anthropic: "Anthropic 官方",
  custom: "自定义端点",
};

export function SettingsModal({
  open,
  onClose,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  sessionId?: string;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("general");

  // 模型与供应商
  const [cfg, setCfg] = useState<ProviderConfig | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  // 记忆
  const [mems, setMems] = useState<MemoryItem[]>([]);
  const [newMem, setNewMem] = useState("");
  const [busy, setBusy] = useState(false);
  // 审批授权（本会话白名单）
  const [grants, setGrants] = useState<string[]>([]);
  // 通知权限态（仅 UI 展示）
  const [notifyPerm, setNotifyPerm] = useState<NotificationPermission | "unsupported">(
    "unsupported",
  );

  const refreshMems = useCallback(async () => {
    setMems(await listMemories());
  }, []);

  const refreshGrants = useCallback(async () => {
    if (sessionId) setGrants(await listGrants(sessionId));
    else setGrants([]);
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const c = await getProviderConfig();
      setCfg(c);
      setCfgErr(c ? null : "无法读取配置（内核版本过旧或未连接）");
    })();
    void refreshMems();
    void refreshGrants();
    setNotifyPerm(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  }, [open, refreshMems, refreshGrants]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const applyCfg = async (patch: { model?: string; thinking?: boolean }) => {
    setBusy(true);
    const next = await patchProviderConfig(patch).finally(() => setBusy(false));
    if (next) {
      setCfg(next);
      setCfgErr(null);
    } else {
      setCfgErr("切换失败");
    }
  };

  const addMem = async () => {
    const content = newMem.trim();
    if (!content || busy) return;
    setBusy(true);
    const ok = await createMemory(content).finally(() => setBusy(false));
    if (ok) {
      setNewMem("");
      await refreshMems();
    }
  };

  const requestNotify = async () => {
    if (typeof Notification === "undefined") return;
    const p = await Notification.requestPermission();
    setNotifyPerm(p);
  };

  const onRevokeGrant = async (tool: string) => {
    if (!sessionId) return;
    setBusy(true);
    const ok = await revokeGrant(sessionId, tool).finally(() => setBusy(false));
    if (ok) await refreshGrants();
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: "general", label: "通用" },
    { key: "provider", label: "模型与供应商" },
    { key: "memory", label: "记忆管理" },
    { key: "grants", label: "审批授权" },
  ];

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 遮罩点击关闭是模态惯例；键盘路径由 Esc 与"关闭"按钮覆盖
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-6"
      style={{ backgroundColor: "rgba(20, 17, 14, 0.45)" }}
      onClick={(e) => {
        // 仅点遮罩本身关闭（不依赖内层 stopPropagation）；键盘路径由 Esc 与"关闭"按钮覆盖
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="系统设置"
        className="flex h-[480px] w-full max-w-[640px] overflow-hidden rounded-2xl border border-hairline bg-base"
      >
        {/* 左 tab 列 */}
        <nav className="flex w-[150px] shrink-0 flex-col gap-1 border-r border-hairline bg-surface p-3">
          <span className="px-2 pb-2 text-[14px] font-[600] text-text">设置</span>
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className="rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-panel"
              style={{
                backgroundColor: tab === t.key ? "var(--panel)" : undefined,
                color: tab === t.key ? "var(--text)" : "var(--muted)",
              }}
            >
              {t.label}
            </button>
          ))}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1.5 text-left text-[13px] text-muted hover:bg-panel hover:text-text"
          >
            关闭
          </button>
        </nav>

        {/* 内容区 */}
        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          {tab === "general" ? (
            <div className="flex flex-col gap-5">
              <section>
                <h3 className="mb-2 text-[13px] font-[600] text-text">外观</h3>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => applyTheme("light")}
                    className="rounded-lg border border-hairline px-3 py-1.5 text-[13px] text-text hover:bg-panel"
                  >
                    亮色
                  </button>
                  <button
                    type="button"
                    onClick={() => applyTheme("dark")}
                    className="rounded-lg border border-hairline px-3 py-1.5 text-[13px] text-text hover:bg-panel"
                  >
                    暗色
                  </button>
                </div>
              </section>
              <section>
                <h3 className="mb-2 text-[13px] font-[600] text-text">审批通知</h3>
                {notifyPerm === "unsupported" ? (
                  <p className="text-[12px] text-muted">当前浏览器不支持桌面通知。</p>
                ) : notifyPerm === "granted" ? (
                  <p className="text-[13px] text-positive">
                    已开启 · Agent 等待审批时若你切走页面将弹桌面提醒
                  </p>
                ) : notifyPerm === "denied" ? (
                  <p className="text-[12px] text-muted">
                    通知已被浏览器拒绝，请在浏览器站点设置中手动允许。
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => void requestNotify()}
                    className="rounded-lg border border-hairline px-3 py-1.5 text-[13px] text-text hover:bg-panel"
                  >
                    开启审批通知
                  </button>
                )}
                <p className="mt-1 text-[12px] text-muted">
                  审批 60 秒自动过期（fail-closed）；开启后切走页面也不会错过。
                </p>
              </section>
              <section>
                <h3 className="mb-2 text-[13px] font-[600] text-text">连接</h3>
                <p className="font-mono text-[12px] text-muted">内核 {readOrigin()}</p>
                <button
                  type="button"
                  onClick={() => {
                    clearCreds();
                    router.push("/");
                  }}
                  className="mt-2 rounded-lg border border-hairline px-3 py-1.5 text-[13px] text-muted hover:bg-panel hover:text-text"
                >
                  断开并重新连接…
                </button>
              </section>
              <section>
                <h3 className="mb-2 text-[13px] font-[600] text-text">账户</h3>
                <p className="text-[13px] text-muted">
                  本地用户（阶段一单用户，本地优先；远程多端账户随阶段二）
                </p>
              </section>
            </div>
          ) : null}

          {tab === "provider" ? (
            <div className="flex flex-col gap-5">
              {cfgErr ? <p className="font-mono text-[12px] text-accent-hot">{cfgErr}</p> : null}
              {cfg ? (
                <>
                  <section>
                    <h3 className="mb-2 text-[13px] font-[600] text-text">供应商</h3>
                    <p className="text-[13px] text-text">{PROVIDER_LABEL[cfg.provider]}</p>
                    <p className="mt-1 font-mono text-[12px] text-muted">
                      {cfg.baseUrl ?? "api.anthropic.com（官方）"}
                    </p>
                    <p className="mt-1 text-[12px] text-muted">
                      API key 经环境变量/配置文件注入，界面不展示不修改（安全纪律）。
                    </p>
                  </section>
                  <section>
                    <h3 className="mb-2 text-[13px] font-[600] text-text">模型</h3>
                    <select
                      value={cfg.model}
                      disabled={busy}
                      onChange={(e) => void applyCfg({ model: e.target.value })}
                      className="w-full max-w-[300px] rounded-md border border-hairline bg-base px-2 py-1.5 font-mono text-[13px] text-text"
                    >
                      {cfg.availableModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[12px] text-muted">
                      切换全局生效（下一次提问起），并持久化到 .arclight/config.json。
                    </p>
                  </section>
                  <section>
                    <h3 className="mb-2 text-[13px] font-[600] text-text">扩展思考</h3>
                    <label className="flex items-center gap-2 text-[13px] text-text">
                      <input
                        type="checkbox"
                        checked={cfg.thinking}
                        disabled={busy}
                        onChange={(e) => void applyCfg({ thinking: e.target.checked })}
                      />
                      启用 thinking（思考过程将展示在对话中）
                    </label>
                  </section>
                </>
              ) : null}
            </div>
          ) : null}

          {tab === "memory" ? (
            <div className="flex flex-col gap-4">
              <section>
                <h3 className="mb-1 text-[13px] font-[600] text-text">记忆管理</h3>
                <p className="text-[12px] text-muted">
                  启用的记忆会作为长期偏好注入每次提问的上下文（跨会话生效）。
                </p>
              </section>
              <div className="flex gap-2">
                <input
                  value={newMem}
                  onChange={(e) => setNewMem(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void addMem()}
                  placeholder="新增记忆，如：回答一律用中文；改动要先写测试…"
                  className="min-w-0 flex-1 rounded-md border border-hairline bg-base px-2 py-1.5 text-[13px] text-text outline-none placeholder:text-muted"
                />
                <button
                  type="button"
                  disabled={busy || !newMem.trim()}
                  onClick={() => void addMem()}
                  className="rounded-md border border-accent px-3 py-1.5 text-[13px] text-accent disabled:opacity-40"
                >
                  添加
                </button>
              </div>
              {mems.length === 0 ? (
                <p className="text-[13px] text-muted">暂无记忆。</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {mems.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-start gap-2 rounded-lg border border-hairline px-3 py-2"
                    >
                      <p
                        className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px]"
                        style={{ color: m.enabled ? "var(--text)" : "var(--muted)" }}
                      >
                        {m.content}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          void updateMemory(m.id, { enabled: !m.enabled }).then(refreshMems)
                        }
                        className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] text-muted hover:bg-panel hover:text-text"
                      >
                        {m.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteMemory(m.id).then(refreshMems)}
                        className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] text-muted hover:text-accent-hot"
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {tab === "grants" ? (
            <div className="flex flex-col gap-4">
              <section>
                <h3 className="mb-1 text-[13px] font-[600] text-text">审批授权（本会话）</h3>
                <p className="text-[12px] text-muted">
                  你点过「本会话允许」的工具会列在这里，对应工具的后续操作自动放行。
                  撤销后该工具下次调用会重新弹审批。黑名单与高危操作永远不在此列。
                </p>
              </section>
              {!sessionId ? (
                <p className="text-[13px] text-muted">
                  未在会话中（从某个会话打开设置可管理其授权）。
                </p>
              ) : grants.length === 0 ? (
                <p className="text-[13px] text-muted">本会话暂无「本会话允许」授权。</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {grants.map((g) => (
                    <li
                      key={g}
                      className="flex items-center gap-2 rounded-lg border border-hairline px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-accent">
                        {g}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-muted">本会话允许</span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onRevokeGrant(g)}
                        className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] text-muted hover:text-accent-hot disabled:opacity-40"
                      >
                        撤销
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

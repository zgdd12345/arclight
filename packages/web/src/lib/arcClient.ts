// arcClient —— 从 localStorage 读 origin/token，构造 client-core 的传输/命令/store/事件流。
// 前端直连内核（D7：无 Next API proxy）。对 @arclight/protocol 只 import type。

import {
  CommandClient,
  type ConnectionStatus,
  EventStreamManager,
  HttpClient,
  SessionStore,
  type Snapshot,
} from "@arclight/client-core";

const ORIGIN_KEY = "arclight.origin";
const TOKEN_KEY = "arclight.token";
// 401/403 后由 clearCreds 置位；writeCreds 清除。防止旧凭据带着空 token 返回非 null。
const NEEDS_REAUTH_KEY = "arclight.needsReauth";
export const DEFAULT_ORIGIN = "http://127.0.0.1:43127";

export type Creds = { origin: string; token: string };

export function readCreds(): Creds | null {
  if (typeof window === "undefined") return null;
  const origin = window.localStorage.getItem(ORIGIN_KEY)?.trim();
  if (!origin) return null;
  // 401 后 clearCreds 设置此标志，强制回到 ConnectPanel 重新填写凭据。
  if (window.localStorage.getItem(NEEDS_REAUTH_KEY)) return null;
  // token 可空：内核 ARCLIGHT_DEV_NO_AUTH=1 时放行（测试）。仅 origin 缺失才视为未连接。
  const token = window.localStorage.getItem(TOKEN_KEY)?.trim() ?? "";
  return { origin, token };
}

export function writeCreds(creds: Creds): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ORIGIN_KEY, creds.origin.trim());
  window.localStorage.setItem(TOKEN_KEY, creds.token.trim());
  // 成功写入新凭据 = 用户主动重连，清除重认证标志。
  window.localStorage.removeItem(NEEDS_REAUTH_KEY);
}

/**
 * 令牌失效后的清理：删除 token + activeWorkspace，并置 needsReauth 标志，
 * 使 readCreds() 返回 null → 首页渲染 ConnectPanel（origin 保留供预填）。
 * DEV_NO_AUTH 场景：用户在 ConnectPanel 以空 token 重新点击「新建会话」即可恢复。
 */
export function clearCreds(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(ACTIVE_WS_KEY);
  window.localStorage.setItem(NEEDS_REAUTH_KEY, "1");
}

export function readOrigin(): string {
  if (typeof window === "undefined") return DEFAULT_ORIGIN;
  return window.localStorage.getItem(ORIGIN_KEY)?.trim() || DEFAULT_ORIGIN;
}

export function readToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(TOKEN_KEY)?.trim() || "";
}

const ACTIVE_WS_KEY = "arclight.activeWorkspace";

export function readActiveWorkspace(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_WS_KEY);
}
export function writeActiveWorkspace(id: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ACTIVE_WS_KEY, id);
}

export type Project = { workspaceId: string; name: string; repoPath: string };
export type ProjectsResponse = {
  ok: boolean;
  projectsRoot: string;
  projects: Project[];
  available: { name: string }[];
};
export type SessionMeta = {
  id: string;
  title: string | null;
  status: string;
  lastEventSeq: number;
  updatedAt: number;
  createdAt: number;
};

/** 凭据 → HttpClient（无凭据返回 null，调用方自行处理跳连接面板）。 */
function authedHttp(): HttpClient | null {
  const creds = readCreds();
  return creds ? new HttpClient({ baseUrl: creds.origin, token: creds.token }) : null;
}

/** GET + ok 校验 + 异常静默：返回响应体（ok 为真时）或 null（无凭据/非 ok/网络异常）。
 *  这些只读展示端点失败都降级为"无数据"，不抛错给 UI——统一在此收口。 */
async function fetchOk<T>(path: string): Promise<T | null> {
  const http = authedHttp();
  if (!http) return null;
  try {
    const r = await http.getJson<{ ok: boolean } & T>(path);
    return r.ok ? r : null;
  } catch {
    return null;
  }
}

export async function listProjects(): Promise<ProjectsResponse | null> {
  const http = authedHttp();
  if (!http) return null;
  return http.getJson<ProjectsResponse>("/api/projects");
}

export async function createProject(name: string): Promise<Project | null> {
  const http = authedHttp();
  if (!http) return null;
  const { body } = await http.postJson<{ ok: boolean } & Project>("/api/projects", { name });
  return body.ok ? body : null;
}

export async function listSessions(workspaceId: string): Promise<SessionMeta[]> {
  const http = authedHttp();
  if (!http) return [];
  const r = await http.getJson<{ ok: boolean; sessions: SessionMeta[] }>(
    `/api/projects/${workspaceId}/sessions`,
  );
  return r.ok ? r.sessions : [];
}

export async function createSession(workspaceId: string, title?: string): Promise<string | null> {
  const http = authedHttp();
  if (!http) return null;
  const { body } = await http.postJson<{ ok: boolean; sessionId?: string }>("/api/sessions", {
    workspaceId,
    ...(title ? { title } : {}),
  });
  return body.ok && body.sessionId ? body.sessionId : null;
}

/** 增删改的统一返回：ok + 服务端 message（409 活跃 turn 等场景给用户看）。 */
export type MutationResult = { ok: boolean; message?: string };

type MutationBody = { ok: boolean; message?: string };

function toMutationResult(body: MutationBody): MutationResult {
  return body.ok ? { ok: true } : { ok: false, message: body.message };
}

export async function renameSession(id: string, title: string): Promise<MutationResult> {
  const http = authedHttp();
  if (!http) return { ok: false, message: "未连接" };
  const { body } = await http.patchJson<MutationBody>(`/api/sessions/${id}`, { title });
  return toMutationResult(body);
}

export async function deleteSession(id: string): Promise<MutationResult> {
  const http = authedHttp();
  if (!http) return { ok: false, message: "未连接" };
  const { body } = await http.deleteJson<MutationBody>(`/api/sessions/${id}`);
  return toMutationResult(body);
}

export async function renameProject(workspaceId: string, name: string): Promise<MutationResult> {
  const http = authedHttp();
  if (!http) return { ok: false, message: "未连接" };
  const { body } = await http.patchJson<MutationBody>(`/api/projects/${workspaceId}`, { name });
  return toMutationResult(body);
}

export async function deleteProject(workspaceId: string): Promise<MutationResult> {
  const http = authedHttp();
  if (!http) return { ok: false, message: "未连接" };
  const { body } = await http.deleteJson<MutationBody>(`/api/projects/${workspaceId}`);
  return toMutationResult(body);
}

// ── 供应商/模型配置（/api/config）──

export type ProviderConfig = {
  provider: "zhipu" | "anthropic" | "custom";
  baseUrl: string | null;
  model: string;
  thinking: boolean;
  availableModels: string[];
};

export async function getProviderConfig(): Promise<ProviderConfig | null> {
  return fetchOk<ProviderConfig>("/api/config");
}

export async function patchProviderConfig(patch: {
  model?: string;
  thinking?: boolean;
}): Promise<ProviderConfig | null> {
  const http = authedHttp();
  if (!http) return null;
  const { body } = await http.patchJson<{ ok: boolean } & ProviderConfig>("/api/config", patch);
  return body.ok ? body : null;
}

// ── 成本/用量（/api/sessions/:id/usage）──

export type SessionUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsdMicros: number;
};

export async function getSessionUsage(sessionId: string): Promise<SessionUsage | null> {
  return fetchOk<SessionUsage>(`/api/sessions/${sessionId}/usage`);
}

// ── 上下文余量（/api/sessions/:id/context-usage）──

export type ContextUsage = { currentTokens: number; effectiveWindow: number };

export async function getContextUsage(sessionId: string): Promise<ContextUsage | null> {
  return fetchOk<ContextUsage>(`/api/sessions/${sessionId}/context-usage`);
}

// ── 检查点时间线（/api/sessions/:id/checkpoints）──

export type Checkpoint = {
  id: string;
  ref: string;
  label: string | null;
  changedFiles: string[];
  turnId: string | null;
  createdAt: number;
};

export async function listCheckpoints(sessionId: string): Promise<Checkpoint[]> {
  const r = await fetchOk<{ checkpoints: Checkpoint[] }>(`/api/sessions/${sessionId}/checkpoints`);
  return r?.checkpoints ?? [];
}

// ── 审批白名单（/api/sessions/:id/grants）──

export async function listGrants(sessionId: string): Promise<string[]> {
  const r = await fetchOk<{ grants: string[] }>(`/api/sessions/${sessionId}/grants`);
  return r?.grants ?? [];
}

export async function revokeGrant(sessionId: string, tool: string): Promise<boolean> {
  const http = authedHttp();
  if (!http) return false;
  const { body } = await http.deleteJson<{ ok: boolean }>(
    `/api/sessions/${sessionId}/grants/${encodeURIComponent(tool)}`,
  );
  return body.ok;
}

// ── 记忆管理（/api/memories）──

export type MemoryItem = { id: string; content: string; enabled: boolean; createdAt: number };

export async function listMemories(): Promise<MemoryItem[]> {
  const r = await fetchOk<{ memories: MemoryItem[] }>("/api/memories");
  return r?.memories ?? [];
}

export async function createMemory(content: string): Promise<boolean> {
  const http = authedHttp();
  if (!http) return false;
  const { body } = await http.postJson<{ ok: boolean }>("/api/memories", { content });
  return body.ok;
}

export async function updateMemory(
  id: string,
  patch: { content?: string; enabled?: boolean },
): Promise<boolean> {
  const http = authedHttp();
  if (!http) return false;
  const { body } = await http.patchJson<{ ok: boolean }>(`/api/memories/${id}`, patch);
  return body.ok;
}

export async function deleteMemory(id: string): Promise<boolean> {
  const http = authedHttp();
  if (!http) return false;
  const { body } = await http.deleteJson<{ ok: boolean }>(`/api/memories/${id}`);
  return body.ok;
}

// ── 附件上传（/api/sessions/:id/files，multipart）──

export async function uploadSessionFile(
  sessionId: string,
  file: File,
): Promise<{ path: string; name: string } | null> {
  const creds = readCreds();
  if (!creds) return null;
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch(`${creds.origin}/api/sessions/${sessionId}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${creds.token}` },
      body: form,
    });
    const body = (await res.json()) as { ok: boolean; path?: string; name?: string };
    return body.ok && body.path ? { path: body.path, name: body.name ?? file.name } : null;
  } catch {
    return null;
  }
}

/**
 * HttpClient.getJson は非 2xx で "GET path -> 401" 形式の Error を throw する。
 * そのメッセージから HTTP status を取り出す。取り出せない場合は null を返す。
 */
export function httpErrorStatus(err: unknown): number | null {
  const m = String(err).match(/-> (\d{3})/);
  return m ? Number(m[1]) : null;
}

export type ArcConnection = {
  http: HttpClient;
  command: CommandClient;
  store: SessionStore;
  stream: EventStreamManager;
  /** 首屏 bootstrap：拉 snapshot 全量重建 → setBookmark → 连 SSE（刷新不丢，DEV_PLAN §2.2）。 */
  bootstrapAndStart: () => Promise<void>;
};

export function createArcConnection(
  sessionId: string,
  onStatus: (status: ConnectionStatus) => void,
  onAuthError?: (httpStatus: number) => void,
): ArcConnection | null {
  const creds = readCreds();
  if (!creds) return null;

  const http = new HttpClient({ baseUrl: creds.origin, token: creds.token });
  const command = new CommandClient(http);
  const store = new SessionStore(sessionId);

  const stream = new EventStreamManager({
    http,
    sessionId,
    onEvents: (batch) => store.applyBatch(batch),
    // resync：先清空，随后 snapshot 事件流经 onEvents 重放（reset 后由 snapshot 重建）。
    onResync: () => store.reset(),
    onStatus,
    // 401/403 终态（token 失效/轮换）：transport 已停重连，这里交回页面处理
    ...(onAuthError ? { onAuthError } : {}),
  });

  const bootstrapAndStart = async (): Promise<void> => {
    try {
      const snap = await http.getJson<Snapshot & { ok: boolean }>(
        `/api/sessions/${sessionId}/snapshot`,
      );
      store.applyBatch(snap.events);
      stream.setBookmark(snap.lastSeq, snap.epoch);
    } catch {
      // snapshot 失败不阻断：仍连 SSE（afterSeq=0），由实时/续接路径补齐。
    }
    stream.start();
  };

  return { http, command, store, stream, bootstrapAndStart };
}

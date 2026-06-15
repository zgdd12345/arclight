// 共享 ProviderConfig 单一真相：让 Composer 的 ModelSwitcher 与 SettingsModal「模型与供应商」
// tab 读同一份配置——任一处热切换后，另一处即时反映（不再各持孤立副本、切换后显示陈旧值）。
// 模块级外部 store + useSyncExternalStore；patch 成功后广播刷新所有订阅者。

import { getProviderConfig, type ProviderConfig, patchProviderConfig } from "./arcClient";

let current: ProviderConfig | null = null;
let inFlight: Promise<void> | null = null;
const subscribers = new Set<() => void>();

function emit(): void {
  for (const fn of subscribers) fn();
}

export function subscribeProviderConfig(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function getProviderConfigSnapshot(): ProviderConfig | null {
  return current;
}

/** 拉取最新配置并广播（去重并发：同一时刻只发一个请求）。 */
export async function refreshProviderConfig(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const c = await getProviderConfig();
    if (c) {
      current = c;
      emit();
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** 切换 model/thinking；成功则更新共享快照并广播。返回是否成功（供调用方做失败提示）。 */
export async function applyProviderPatch(patch: {
  model?: string;
  thinking?: boolean;
}): Promise<boolean> {
  const next = await patchProviderConfig(patch);
  if (!next) return false;
  current = next;
  emit();
  return true;
}

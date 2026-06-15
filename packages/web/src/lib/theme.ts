// 主题切换单点：设 data-theme + 持久化（localStorage）。SessionStatusBar 与 SettingsModal 共用。
// 注：首帧前防闪烁的回填在 layout.tsx 是内联脚本（无法 import），与此处保持同一 key/属性。

export type Theme = "light" | "dark";
export const THEME_KEY = "arclight.theme";

export function applyTheme(next: Theme): void {
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // 隐私模式等 localStorage 不可用：仅本次会话生效
  }
}

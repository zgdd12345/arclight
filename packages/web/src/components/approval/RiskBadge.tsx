"use client";

// RiskBadge —— 风险电压表（DESIGN.md 信任面纪律③「风险徽章四级标尺」）。
// READ 鼠尾草(--positive) → WRITE/confirm 琥珀(--accent) →
// NETWORK/elevated 电弧紫(--violet) → IRREVERSIBLE|FUNDS 危险红(--hazard)。
// mono 字体 + 圆点 + 单线边框，像电压表不像彩色 chip。未知风险一律按最高档（hazard）。
//
// hazard 红 #FF4D2E 是信任面专属：此徽章只在审批面（PermissionModal）使用，
// 故 hazard 档允许出现红色；台架仪器卡（ToolCallCard）另有非红降级映射。

import type { ReactElement } from "react";

export type RiskLevelKey = "read" | "write" | "elevated" | "hazard";

type LevelMeta = { label: string; color: string };

const LEVELS: Record<RiskLevelKey, LevelMeta> = {
  read: { label: "READ", color: "var(--positive)" },
  write: { label: "WRITE", color: "var(--accent)" },
  elevated: { label: "ELEVATED", color: "var(--violet)" },
  hazard: { label: "HAZARD", color: "var(--hazard)" },
};

// risk(low/med/high) + cls(read/write/irreversible/funds) → 四级标尺。
// cls 决定基档；read/write 遇 risk=high 升一档到 elevated（network/越权类高危）。
// irreversible/funds 永远是最高档 hazard；未知 cls 同样按 hazard（fail-closed 视觉）。
export function resolveRiskLevel(risk: string, cls: string): RiskLevelKey {
  switch (cls) {
    case "read":
      return risk === "high" ? "elevated" : "read";
    case "write":
      return risk === "high" ? "elevated" : "write";
    case "irreversible":
    case "funds":
      return "hazard";
    default:
      return "hazard"; // 未知 cls → 最高档（DESIGN.md「未知风险按最高档显示」）
  }
}

// 高危判定：cls=irreversible/funds 或 risk=high → 批准需 hold-to-confirm。
export function isDangerousRisk(risk: string, cls: string): boolean {
  return cls === "irreversible" || cls === "funds" || risk === "high";
}

// 颜色取自当前档（供 PermissionModal 复用，使按钮/进度条与徽章同色）。
export function riskLevelColor(risk: string, cls: string): string {
  return LEVELS[resolveRiskLevel(risk, cls)].color;
}

export function RiskBadge({ risk, cls }: { risk: string; cls: string }): ReactElement {
  const meta = LEVELS[resolveRiskLevel(risk, cls)];
  return (
    <span
      className="inline-flex items-center gap-2 border px-2 py-1 text-[11px] uppercase tracking-wider"
      style={{ borderColor: meta.color, color: meta.color, fontFamily: "var(--font-mono)" }}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: meta.color }}
        aria-hidden
      />
      {meta.label}
      <span className="opacity-70">· {cls || "unknown"}</span>
    </span>
  );
}

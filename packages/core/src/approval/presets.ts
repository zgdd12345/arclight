import type { RiskClass, RiskTier, Tool } from "@arclight/protocol";
import { parse as shellParse } from "shell-quote";

// 风险分类（P0 §C 审批策略 + DEV_PLAN §2.3）：
// safe+read 自动放行；confirm 发 permission.ask（默认 60s）；admin_only P0 默认拒绝；
// 黑名单永拒（不弹审批，直接 deny）。bash 命令用 shell-quote 分词后再判级。

export type RiskDecision =
  | { kind: "auto-allow" }
  | { kind: "ask"; risk: "low" | "med" | "high"; cls: RiskClass; action: string }
  | { kind: "deny"; reason: string };

// 黑名单（DEV_PLAN §5.2 DoD #4）：命中即永拒。matcher 收单个 shell 段（已按 ;|&&|\|\| 拆分），
// 故 t[0] 看到的是该段的首命令——防 `true; sudo id` 类复合命令把危险命令藏在非首位。
const BLACKLIST_MATCHERS: { test: (tokens: string[], seg: string) => boolean; reason: string }[] = [
  {
    reason: "sudo / 提权一律拒绝",
    test: (t) => t[0] === "sudo" || t[0] === "su" || t[0] === "doas",
  },
  {
    // 仅拦裸根 "/"、家目录 ~ / $HOME、根级通配 /*；普通目录（build/ 等）放行交审批。
    // rm 的 -r 与 -f 既匹配组合 flag（-rf）也匹配分开 flag（-r -f）。
    reason: "rm -rf 家目录 / 根 一律拒绝",
    test: (t, seg) => {
      if (t[0] !== "rm" && !/\brm\b/.test(seg)) return false;
      const hasR =
        t.some((tok) => /^-[a-zA-Z]*r/i.test(tok)) || /-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r/.test(seg);
      const hasF =
        t.some((tok) => /^-[a-zA-Z]*f/.test(tok)) || /-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r/.test(seg);
      if (!hasR || !hasF) return false;
      if (/(^|\s)(~|\$HOME)(\/|\s|$)/.test(seg)) return true; // ~ / $HOME 起头目标
      return t.some((tok) => tok === "/" || tok === "~" || tok === "$HOME" || tok === "/*");
    },
  },
  {
    // ~/.ssh、/.ssh、$HOME/.ssh、以及相对 .ssh（cat .ssh/id_rsa）一律拒绝
    reason: "访问 SSH 私钥目录一律拒绝",
    test: (_t, seg) => /(^|[^\w.])(~\/|\/|\$HOME\/)?\.ssh(\/|\b)/.test(seg),
  },
  {
    reason: "访问云/凭证目录一律拒绝",
    test: (_t, seg) => /(^|[^\w.])(~\/|\/|\$HOME\/)?\.(aws|gnupg)(\/|\b)|~\/\.config\/gh/.test(seg),
  },
  {
    reason: "挂载 docker socket 一律拒绝",
    test: (_t, seg) => /docker\.sock|\/var\/run\/docker/.test(seg),
  },
  {
    reason: "ssh/scp 外联一律拒绝（凭证不在执行域）",
    test: (t) => t[0] === "ssh" || t[0] === "scp" || t[0] === "sftp",
  },
  {
    reason: "读取系统密钥串一律拒绝",
    test: (_t, seg) => /\bsecurity\s+(find-|dump-)|keychain|\/etc\/shadow/.test(seg),
  },
];

export function bashTokens(command: string): string[] {
  try {
    return shellParse(command)
      .filter((e): e is string => typeof e === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return command.split(/\s+/);
  }
}

/** 按 shell 控制符拆段（;|&&|\|\||\| 与换行）。过度拆分只会更安全（fail-closed），
 *  引号内的分隔符虽可能误拆，但误拆产生的段不匹配黑名单即放行，不引入危险。 */
function splitSegments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;|\||\n)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function checkBlacklist(command: string, depth = 0): { blocked: boolean; reason?: string } {
  for (const seg of splitSegments(command)) {
    const tokens = bashTokens(seg);
    for (const m of BLACKLIST_MATCHERS) {
      if (m.test(tokens, seg)) return { blocked: true, reason: m.reason };
    }
    // 递归进 sh/bash/zsh -c '<inner>'，防把危险命令藏进内层 shell（深度限 3 防爆栈）
    if (depth < 3 && (tokens[0] === "sh" || tokens[0] === "bash" || tokens[0] === "zsh")) {
      const ci = tokens.indexOf("-c");
      const inner = ci >= 0 ? tokens[ci + 1] : undefined;
      if (inner) {
        const r = checkBlacklist(inner, depth + 1);
        if (r.blocked) return r;
      }
    }
  }
  return { blocked: false };
}

const RISK_BY_TIER: Record<RiskTier, "low" | "med" | "high"> = {
  safe: "low",
  confirm: "med",
  admin_only: "high",
};

/** 纯策略：给定工具元数据 + 实参，返回放行/询问/拒绝。dangerFullAccess 默认 false。 */
export function classify(
  tool: Tool<unknown, unknown>,
  args: unknown,
  opts: { dangerFullAccess?: boolean } = {},
): RiskDecision {
  const { meta } = tool;

  // bash：先过黑名单（永拒），再按命令内容可能升级风险
  if (meta.name === "bash") {
    const command =
      typeof (args as { command?: unknown })?.command === "string"
        ? (args as { command: string }).command
        : "";
    const bl = checkBlacklist(command);
    if (bl.blocked) return { kind: "deny", reason: bl.reason ?? "blacklisted command" };
  }

  // safe + read：自动放行
  if (meta.riskTier === "safe" && meta.riskClass === "read") {
    return { kind: "auto-allow" };
  }

  // admin_only：P0 默认拒绝（除非显式 danger-full-access）
  if (meta.riskTier === "admin_only" && !opts.dangerFullAccess) {
    return { kind: "deny", reason: `${meta.name} requires admin access (disabled by default)` };
  }

  // 其余（confirm，或 admin_only+dangerFullAccess）：发审批
  const risk = RISK_BY_TIER[meta.riskTier];
  return {
    kind: "ask",
    risk,
    cls: meta.riskClass,
    action: actionLabel(meta.name, args),
  };
}

function actionLabel(name: string, args: unknown): string {
  if (name === "bash" && typeof (args as { command?: unknown })?.command === "string") {
    return (args as { command: string }).command;
  }
  if (typeof (args as { path?: unknown })?.path === "string") {
    return `${name} ${(args as { path: string }).path}`;
  }
  return name;
}

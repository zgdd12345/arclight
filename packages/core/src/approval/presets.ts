import type { RiskClass, RiskTier, Tool, ToolMeta } from "@arclight/protocol";
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

/** 按 shell 控制符拆段（;|&&|\|\||\||& 与换行）。过度拆分只会更安全（fail-closed），
 *  引号内的分隔符虽可能误拆，但误拆产生的段不匹配黑名单即放行，不引入危险。
 *  "&"（后台/分隔）必须在此出现：shell-quote 把 `true & sudo id` 的 & 吐成 op token，
 *  分词后首命令仍是 true，会漏掉 & 之后的 sudo——故在拆段阶段就按 & 切开。 */
function splitSegments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;|\||&|\n)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 良性前缀启动器：本身无害，但会把真实首命令往后挪（env sudo id / nohup env sudo id）。
// 剥掉它们（连同自身的选项 token、以及 nice/timeout 的一个数值/时长参数）后再看新的首命令。
const LAUNCHERS = new Set([
  "env",
  "nohup",
  "nice",
  "time",
  "eval",
  "exec",
  "command",
  "setsid",
  "stdbuf",
  "ionice",
  "timeout",
]);
// 这两个 launcher 在选项之后还吃一个数值/时长位置参数（nice 10 / timeout 5s）。
const NUMERIC_ARG_LAUNCHERS = new Set(["nice", "timeout"]);

/** 迭代剥离前导 VAR=val 赋值 + 良性启动器，暴露真正的首命令 token。
 *  recall 偏向：宁可多剥（把更靠后的命令当首命令判）也不漏判危险命令。 */
function stripLaunchers(tokens: string[]): string[] {
  let toks = tokens;
  for (let guard = 0; guard <= tokens.length; guard++) {
    let i = 0;
    // 1. 前导环境赋值（FOO=bar sudo id）
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i] ?? "")) i++;
    const head = toks[i];
    if (head === undefined || !LAUNCHERS.has(head)) return toks.slice(i);
    i++; // 启动器本身
    // 2. 启动器自己的选项 token（-x / --foo）
    while (i < toks.length && (toks[i] ?? "").startsWith("-")) i++;
    // 3. nice/timeout：再吃一个数值/时长参数
    if (NUMERIC_ARG_LAUNCHERS.has(head) && i < toks.length && /^\d+[smhd]?$/.test(toks[i] ?? "")) {
      i++;
    }
    toks = toks.slice(i);
  }
  return toks;
}

/** 抠出命令替换体：$(...)（按括号计数处理嵌套）与 `...`（反引号）。
 *  shell-quote 会把替换体打散成 operator token（首命令判级看不到内部），
 *  故必须直接从原始串里提取替换体再递归过黑名单（echo $(sudo id) / echo `sudo id`）。 */
function extractCommandSubstitutions(command: string): string[] {
  const bodies: string[] = [];
  // $(...)：括号计数支持嵌套 $(echo $(sudo id))
  for (let i = 0; i < command.length; i++) {
    if (command[i] === "$" && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < command.length && depth > 0; j++) {
        if (command[j] === "(") depth++;
        else if (command[j] === ")") depth--;
      }
      if (depth === 0) bodies.push(command.slice(i + 2, j - 1));
    }
  }
  // `...`：反引号（shell 本身不支持裸嵌套，简单成对匹配即可）
  for (const m of command.matchAll(/`([^`]*)`/g)) bodies.push(m[1] ?? "");
  return bodies;
}

export function checkBlacklist(command: string, depth = 0): { blocked: boolean; reason?: string } {
  // 命令替换体先抠出来递归判（shell-quote 会把 $(...)/`...` 打散成 op token，漏掉内部命令）
  if (depth < 3) {
    for (const body of extractCommandSubstitutions(command)) {
      const r = checkBlacklist(body, depth + 1);
      if (r.blocked) return r;
    }
  }
  for (const seg of splitSegments(command)) {
    // 剥掉良性前缀启动器（env/nohup/timeout… + VAR=val），用真实首命令判级
    const head = stripLaunchers(bashTokens(seg));
    for (const m of BLACKLIST_MATCHERS) {
      if (m.test(head, seg)) return { blocked: true, reason: m.reason };
    }
    // 递归进 sh/bash/zsh -c '<inner>'，防把危险命令藏进内层 shell（深度限 3 防爆栈）。
    // 组合 flag（-lc/-cx）也算携带 -c：任一匹配 /^-[A-Za-z]*c[A-Za-z]*$/ 的 flag 后，
    // 取其后第一个非 flag token 作内层脚本。
    if (depth < 3 && (head[0] === "sh" || head[0] === "bash" || head[0] === "zsh")) {
      const flagIdx = head.findIndex((t) => /^-[A-Za-z]*c[A-Za-z]*$/.test(t));
      let inner: string | undefined;
      if (flagIdx >= 0) {
        for (let j = flagIdx + 1; j < head.length; j++) {
          if (!(head[j] ?? "").startsWith("-")) {
            inner = head[j];
            break;
          }
        }
      }
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

  // 命令执行器（capability=executesShellCommands，非 name 特判）：先过黑名单（永拒），
  // 再按命令内容可能升级风险。约定命令落在 `command` 实参——任何会执行 shell 的工具都纳管，
  // 不再让未来的命令执行器因名字不叫 "bash" 而绕过黑名单。
  if (meta.executesShellCommands) {
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
    action: actionLabel(meta, args),
  };
}

function actionLabel(meta: ToolMeta, args: unknown): string {
  // 命令执行器：标签即命令全文（capability 驱动，非 name 特判）
  if (meta.executesShellCommands && typeof (args as { command?: unknown })?.command === "string") {
    return (args as { command: string }).command;
  }
  if (typeof (args as { path?: unknown })?.path === "string") {
    return `${meta.name} ${(args as { path: string }).path}`;
  }
  return meta.name;
}

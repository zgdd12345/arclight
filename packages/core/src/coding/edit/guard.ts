import type { EditBlock } from "./parser";

// EditGuard（借 aider 截断/省略号启发，TS 重写）：在 apply 前拦截可疑编辑，
// 防止模型把"省略中段"的占位当真实内容写入。返回违规则 apply_patch 抛 VALIDATION。

export type GuardViolation = { block: number; reason: string };

const DOTS_RE = /^\s*\.\.\.\s*$/;
const TRUNCATION_HINTS = [
  /^\s*\/\/\s*\.\.\.\s*(rest|remaining|existing|unchanged|previous)/i,
  /^\s*#\s*\.\.\.\s*(rest|remaining|existing|unchanged|previous)/i,
  /\b(rest of (the )?(file|code|function)|unchanged code|existing code here)\b/i,
];

export function guardEditBlocks(blocks: EditBlock[]): GuardViolation[] {
  const violations: GuardViolation[] = [];
  blocks.forEach((b, i) => {
    const searchDots = countDots(b.search);
    const replaceDots = countDots(b.replace);
    // 省略号未配对：SEARCH 与 REPLACE 的 ... 段数必须相等（aider try_dotdotdots 前置）
    if (searchDots !== replaceDots) {
      violations.push({
        block: i,
        reason: `unpaired ellipsis: SEARCH has ${searchDots} "...", REPLACE has ${replaceDots}`,
      });
    }
    // 截断占位：REPLACE 段含"// ... rest of file"类注释 → 模型偷懒省略，会丢代码
    for (const line of b.replace.split("\n")) {
      if (TRUNCATION_HINTS.some((re) => re.test(line))) {
        violations.push({
          block: i,
          reason: `truncation placeholder in REPLACE ("${line.trim().slice(0, 50)}") — write the full content, do not elide`,
        });
        break;
      }
    }
  });
  return violations;
}

function countDots(text: string): number {
  return text.split("\n").filter((l) => DOTS_RE.test(l)).length;
}

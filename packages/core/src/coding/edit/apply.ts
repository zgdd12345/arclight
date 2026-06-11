// SEARCH/REPLACE 应用阶梯（借 aider editblock_coder.py 语义，TS 重写；NOTICE 归因）。
// MVP S1 只跑阶梯 1-3（fuzzy/diff-match-patch 为 S2 显式 opt-in，slice4/U5 落地）：
//   ① 逐字完美匹配 → ② 容忍前导空白偏移 → ③ 省略号（...）分段配对
// 失败返回 did-you-mean（find_similar_lines，相似度阈值 0.6），绝不静默乱改。

export type ApplyResult =
  | { ok: true; content: string }
  | { ok: false; reason: string; didYouMean?: string };

export function applyEdit(content: string, search: string, replace: string): ApplyResult {
  // 空 search = 新文件/追加（aider 语义：空 SEARCH 对空文件是创建）
  if (search.trim() === "") {
    return { ok: true, content: content === "" ? replace : content + replace };
  }

  // ── 阶梯①：逐字完美 ──
  const idx = content.indexOf(search);
  if (idx !== -1) {
    return {
      ok: true,
      content: content.slice(0, idx) + replace + content.slice(idx + search.length),
    };
  }

  // 行级预处理（保留行尾换行的一致性处理）
  const contentLines = splitKeepEol(content);
  const searchLines = splitKeepEol(ensureEol(search));
  const replaceLines = splitKeepEol(ensureEol(replace));

  // ── 阶梯②：容忍前导空白（aider replace_part_with_missing_leading_whitespace）──
  const ws = tryWhitespaceFlexible(contentLines, searchLines, replaceLines);
  if (ws !== null) return { ok: true, content: ws };

  // ── 阶梯③：省略号分段（aider try_dotdotdots；未配对 … 即错误）──
  const dots = tryDotDotDots(content, ensureEol(search), ensureEol(replace));
  if (dots.matched) {
    return dots.ok ? { ok: true, content: dots.content } : { ok: false, reason: dots.reason };
  }

  // ── 失败：did-you-mean ──
  const similar = findSimilarLines(search, content);
  return {
    ok: false,
    reason: "SEARCH block not found in file (exact / whitespace-flexible / dotdotdots all failed)",
    ...(similar !== null ? { didYouMean: similar } : {}),
  };
}

// ── 阶梯② ──
function tryWhitespaceFlexible(
  contentLines: string[],
  searchLines: string[],
  replaceLines: string[],
): string | null {
  const n = searchLines.length;
  if (n === 0 || contentLines.length < n) return null;
  outer: for (let i = 0; i + n <= contentLines.length; i++) {
    let offset: string | null = null; // 统一的前导空白差
    for (let j = 0; j < n; j++) {
      const c = contentLines[i + j] ?? "";
      const s = searchLines[j] ?? "";
      if (s.trim() === "" && c.trim() === "") continue; // 空行宽容
      if (c.trimEnd().endsWith(s.trim()) === false || c.trim() !== s.trim()) continue outer;
      const cIndent = c.slice(0, c.length - c.trimStart().length);
      const sIndent = s.slice(0, s.length - s.trimStart().length);
      if (!cIndent.startsWith(sIndent)) continue outer;
      const diff = cIndent.slice(sIndent.length);
      if (offset === null) offset = diff;
      else if (offset !== diff) continue outer; // 偏移必须全段一致
    }
    if (offset === null) offset = "";
    const replaced = replaceLines.map((l) => (l.trim() === "" ? l : offset + l));
    return [...contentLines.slice(0, i), ...replaced, ...contentLines.slice(i + n)].join("");
  }
  return null;
}

// ── 阶梯③ ──
function tryDotDotDots(
  content: string,
  search: string,
  replace: string,
):
  | { matched: false }
  | { matched: true; ok: true; content: string }
  | { matched: true; ok: false; reason: string } {
  const dotsRe = /^\s*\.\.\.\s*$/m;
  if (!dotsRe.test(search) && !dotsRe.test(replace)) return { matched: false };

  // 捕获组使分隔符进入结果数组 → filter i%2===0 取非分隔段（String.split 忽略 g 标志）
  const splitRe = /(^\s*\.\.\.\s*\n)/m;
  const searchPieces = search.split(splitRe).filter((_, i) => i % 2 === 0);
  const replacePieces = replace.split(splitRe).filter((_, i) => i % 2 === 0);
  if (searchPieces.length !== replacePieces.length) {
    return { matched: true, ok: false, reason: "unpaired ... in SEARCH vs REPLACE" };
  }
  let result = content;
  for (let k = 0; k < searchPieces.length; k++) {
    const s = searchPieces[k] ?? "";
    const r = replacePieces[k] ?? "";
    if (s === "" && r === "") continue;
    if (s === "") {
      // 纯新增段：拒绝（无锚点），与 aider 一致
      return { matched: true, ok: false, reason: "dotdotdots piece has empty SEARCH anchor" };
    }
    const at = result.indexOf(s);
    if (at === -1) {
      return { matched: true, ok: false, reason: `dotdotdots piece not found: ${s.slice(0, 60)}` };
    }
    if (result.indexOf(s, at + 1) !== -1) {
      return { matched: true, ok: false, reason: "dotdotdots piece is not unique in file" };
    }
    result = result.slice(0, at) + r + result.slice(at + s.length);
  }
  return { matched: true, ok: true, content: result };
}

// ── did-you-mean（aider find_similar_lines，阈值 0.6）──
export function findSimilarLines(search: string, content: string, threshold = 0.6): string | null {
  const searchLines = search.split("\n").filter((l) => l.trim() !== "");
  const contentLines = content.split("\n");
  if (searchLines.length === 0) return null;
  let best = 0;
  let bestAt = -1;
  for (let i = 0; i + searchLines.length <= contentLines.length; i++) {
    const window = contentLines.slice(i, i + searchLines.length);
    const score = similarity(searchLines.join("\n"), window.join("\n"));
    if (score > best) {
      best = score;
      bestAt = i;
    }
  }
  if (best < threshold || bestAt === -1) return null;
  const lo = Math.max(0, bestAt - 2);
  const hi = Math.min(contentLines.length, bestAt + searchLines.length + 2);
  return contentLines.slice(lo, hi).join("\n");
}

/** 简化 ratio（字符 bigram Dice 系数）——够 0.6 阈值判定用 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ma = bigrams(a);
  const mb = bigrams(b);
  let inter = 0;
  for (const [g, c] of ma) inter += Math.min(c, mb.get(g) ?? 0);
  const total = Math.max(1, a.length - 1) + Math.max(1, b.length - 1);
  return (2 * inter) / total;
}

function ensureEol(s: string): string {
  return s.endsWith("\n") || s === "" ? s : `${s}\n`;
}

function splitKeepEol(s: string): string[] {
  // 行尾换行保留在各行末尾：lookbehind 在每个 \n 后切分（"a\nb\n"→["a\n","b\n"]，"abc"→["abc"]）
  return s === "" ? [] : s.split(/(?<=\n)/);
}

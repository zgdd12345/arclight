import { personalizedPageRank, type WeightedEdge } from "./pagerank";
import type { RepoMapEntry, Tag } from "./types";

// RepoMap 图构建 + pagerank（权重逐字对齐 aider repomap.py:487-514，不可改）。

export type RankOptions = {
  /** 用户在对话中提及的标识符（mentioned_idents）→ ×10 */
  mentionedIdents?: Set<string>;
  /** 当前对话涉及的文件（chat_rel_fnames）→ referencer 命中 ×50 + personalize */
  chatFiles?: Set<string>;
};

export function rankTags(tags: Tag[], opts: RankOptions = {}): RepoMapEntry[] {
  const mentioned = opts.mentionedIdents ?? new Set<string>();
  const chatFiles = opts.chatFiles ?? new Set<string>();

  // defines[ident] = Set<file>；references[ident] = file[]（计数）；defLines 收集
  const defines = new Map<string, Set<string>>();
  const references = new Map<string, string[]>();
  const fileDefLines = new Map<string, Map<string, number[]>>(); // file → ident → lines
  const allFiles = new Set<string>();

  for (const t of tags) {
    allFiles.add(t.relPath);
    if (t.kind === "def") {
      if (!defines.has(t.name)) defines.set(t.name, new Set());
      defines.get(t.name)?.add(t.relPath);
      if (!fileDefLines.has(t.relPath)) fileDefLines.set(t.relPath, new Map());
      const dl = fileDefLines.get(t.relPath) as Map<string, number[]>;
      if (!dl.has(t.name)) dl.set(t.name, []);
      dl.get(t.name)?.push(t.line);
    } else {
      if (!references.has(t.name)) references.set(t.name, []);
      references.get(t.name)?.push(t.relPath);
    }
  }

  // 无 ref 的 def：aider 用 def 自身作 referencer（这样孤立 def 也参与排名）
  for (const [ident, files] of defines) {
    if (!references.has(ident)) {
      references.set(ident, [...files]);
    }
  }

  const nodeSet = new Set<string>(allFiles);
  const edges: WeightedEdge[] = [];

  for (const [ident, definerSet] of defines) {
    const definers = [...definerSet];
    // ── 权重乘子（aider repomap.py:487-499 逐字对齐）──
    let mul = 1.0;
    const isSnake = ident.includes("_") && /[a-zA-Z]/.test(ident);
    const isKebab = ident.includes("-") && /[a-zA-Z]/.test(ident);
    const isCamel = /[A-Z]/.test(ident) && /[a-z]/.test(ident);
    if (mentioned.has(ident)) mul *= 10;
    if ((isSnake || isKebab || isCamel) && ident.length >= 8) mul *= 10;
    if (ident.startsWith("_")) mul *= 0.1;
    if (definerSet.size > 5) mul *= 0.1; // 过度定义

    // Counter(references[ident]) → 每 referencer 的引用计数
    const refCounts = new Map<string, number>();
    for (const r of references.get(ident) ?? []) refCounts.set(r, (refCounts.get(r) ?? 0) + 1);

    for (const [referencer, numRefs] of refCounts) {
      for (const definer of definers) {
        let useMul = mul;
        if (chatFiles.has(referencer)) useMul *= 50; // chat referencer ×50
        const scaledRefs = Math.sqrt(numRefs); // 高频降权
        nodeSet.add(referencer);
        nodeSet.add(definer);
        // 自环（无 ref 的 def）只保留节点不加边——自环在幂迭代里会困住并放大 rank，
        // aider 在真实大仓里被海量真实边稀释，小图会失真。语义等价：未引用 def = dangling，得基线 rank。
        if (referencer === definer) continue;
        edges.push({ from: referencer, to: definer, weight: useMul * scaledRefs });
      }
    }
  }

  const nodes = [...nodeSet];
  if (nodes.length === 0) return [];

  // personalize = 100 / num_files（仅 chatFiles）——aider repomap.py:383
  let personalization: Map<string, number> | null = null;
  if (chatFiles.size > 0) {
    const p = 100 / chatFiles.size;
    personalization = new Map();
    for (const f of chatFiles) if (nodeSet.has(f)) personalization.set(f, p);
  }

  const ranked = personalizedPageRank(nodes, edges, personalization);

  const entries: RepoMapEntry[] = [];
  for (const f of allFiles) {
    const rank = ranked.get(f) ?? 0;
    const dl = fileDefLines.get(f);
    const lines = dl ? [...new Set([...dl.values()].flat())].sort((a, b) => a - b) : [];
    const names = dl ? [...dl.keys()] : []; // 符号名 = 该文件 def 标识符（即 fileDefLines 的 key）
    entries.push({ relPath: f, rank, lines, names });
  }
  entries.sort((a, b) => b.rank - a.rank);
  return entries;
}

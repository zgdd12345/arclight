// 加权 + personalized PageRank（对齐 aider 用的 networkx.pagerank(weight, personalization)）。
// graphology-metrics 的 pagerank 不支持 personalization，而 aider 的 chat-file 偏置核心依赖它，
// 故自研（first-principles）。算法 = 标准幂迭代，出边按权重分配，dangling 与 personalization 标准处理。

export type WeightedEdge = { from: string; to: string; weight: number };

export function personalizedPageRank(
  nodes: string[],
  edges: WeightedEdge[],
  personalization: Map<string, number> | null,
  opts: { damping?: number; maxIter?: number; tol?: number } = {},
): Map<string, number> {
  const d = opts.damping ?? 0.85;
  const maxIter = opts.maxIter ?? 100;
  const tol = opts.tol ?? 1e-6;
  const n = nodes.length;
  if (n === 0) return new Map();

  const idx = new Map(nodes.map((node, i) => [node, i]));
  // 出边权重和 + 邻接（按权重）
  const outWeight = new Float64Array(n);
  const adj: { to: number; w: number }[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    const f = idx.get(e.from);
    const t = idx.get(e.to);
    if (f === undefined || t === undefined) continue;
    adj[f]?.push({ to: t, w: e.weight });
    outWeight[f] = (outWeight[f] ?? 0) + e.weight;
  }

  // personalization 向量（归一化）；无则均匀
  const p = new Float64Array(n);
  if (personalization && personalization.size > 0) {
    let sum = 0;
    for (const [node, v] of personalization) {
      const i = idx.get(node);
      if (i !== undefined) {
        p[i] = v;
        sum += v;
      }
    }
    if (sum > 0) for (let i = 0; i < n; i++) p[i] = (p[i] ?? 0) / sum;
    else p.fill(1 / n);
  } else {
    p.fill(1 / n);
  }

  let rank = new Float64Array(n);
  rank.fill(1 / n);

  for (let iter = 0; iter < maxIter; iter++) {
    const next = new Float64Array(n);
    let danglingSum = 0;
    for (let i = 0; i < n; i++) {
      if ((outWeight[i] ?? 0) === 0) danglingSum += rank[i] ?? 0; // dangling node
    }
    for (let i = 0; i < n; i++) {
      // teleport（含 personalization）+ dangling 再分配
      next[i] = (1 - d) * (p[i] ?? 0) + d * danglingSum * (p[i] ?? 0);
    }
    for (let i = 0; i < n; i++) {
      const ri = rank[i] ?? 0;
      const ow = outWeight[i] ?? 0;
      if (ow === 0) continue;
      for (const { to, w } of adj[i] ?? []) {
        next[to] = (next[to] ?? 0) + d * ri * (w / ow);
      }
    }
    // 收敛判定（L1）
    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs((next[i] ?? 0) - (rank[i] ?? 0));
    rank = next;
    if (delta < tol) break;
  }

  const out = new Map<string, number>();
  for (let i = 0; i < n; i++) out.set(nodes[i] as string, rank[i] ?? 0);
  return out;
}

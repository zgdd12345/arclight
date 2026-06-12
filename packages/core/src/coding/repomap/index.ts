import { countTokens } from "@anthropic-ai/tokenizer";
import { type RankOptions, rankTags } from "./builder";
import { TagCache } from "./cache";
import { extractTags } from "./tag-extractor";
import type { RepoMapEntry, Tag } from "./types";

// RepoMap 门面：抽 Tag（mtime 缓存）→ pagerank → 二分裁剪到 token 预算 → 渲染。

export class RepoMap {
  private cache: TagCache | null = null;

  constructor(
    private readonly repoRoot: string,
    arclightDir?: string,
  ) {
    if (arclightDir) {
      try {
        this.cache = new TagCache(arclightDir);
      } catch {
        this.cache = null; // 缓存不可用不阻断
      }
    }
  }

  async collectTags(relPaths: string[]): Promise<Tag[]> {
    // 有界并发抽 Tag（冷缓存下最多 200 文件，串行 await 过慢）；结果按 relPaths 原序回填
    // 保证确定性输出。cache get/put 同步，仅 extractTags 跨 await，故无缓存竞态。
    const results: Tag[][] = new Array(relPaths.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= relPaths.length) return;
        const rel = relPaths[i];
        if (rel === undefined) continue;
        const cached = this.cache?.get(this.repoRoot, rel);
        if (cached) {
          results[i] = cached;
          continue;
        }
        const tags = await extractTags(this.repoRoot, rel);
        this.cache?.put(this.repoRoot, rel, tags);
        results[i] = tags;
      }
    };
    const pool = Math.min(8, relPaths.length);
    await Promise.all(Array.from({ length: pool }, () => worker()));

    const all: Tag[] = [];
    for (const tags of results) {
      if (tags) all.push(...tags);
    }
    return all;
  }

  /** 生成 RepoMap 文本，二分裁剪到 maxTokens 预算（aider 二分：mid=floor(maxTokens/25)，容差 0.15）。 */
  async generate(relPaths: string[], maxTokens: number, opts: RankOptions = {}): Promise<string> {
    const tags = await this.collectTags(relPaths);
    if (tags.length === 0) return "";
    const ranked = rankTags(tags, opts).filter((e) => e.names.length > 0);
    if (ranked.length === 0) return "";

    const tol = 0.15;
    let lower = 0;
    let upper = ranked.length;
    let best = "";
    let mid = Math.min(ranked.length, Math.max(1, Math.floor(maxTokens / 25)));

    // 二分：找放得下 maxTokens 的最多条目数
    for (let iter = 0; iter < 15 && lower <= upper; iter++) {
      const text = renderMap(ranked.slice(0, mid));
      const tokens = countTokens(text);
      if (tokens < maxTokens * (1 + tol)) {
        best = text;
        if (tokens > maxTokens * (1 - tol)) break; // 落在容差带内
        lower = mid + 1;
      } else {
        upper = mid - 1;
      }
      mid = Math.floor((lower + upper) / 2);
      if (mid < 1) mid = 1;
      if (mid > ranked.length) break;
    }
    return best || renderMap(ranked.slice(0, 1));
  }

  close(): void {
    this.cache?.close();
  }
}

function renderMap(entries: RepoMapEntry[]): string {
  if (entries.length === 0) return "";
  const lines = ["# Repository map (most relevant symbols)"];
  for (const e of entries) {
    const names = e.names.slice(0, 20).join(", ");
    lines.push(`\n${e.relPath}:`);
    lines.push(`  ${names}`);
  }
  return lines.join("\n");
}

export type { RankOptions } from "./builder";
export { rankTags } from "./builder";
export type { RepoMapEntry, Tag } from "./types";

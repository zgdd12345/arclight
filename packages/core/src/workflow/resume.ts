import type { JournalRow } from "./types";

export type ConsultResult = { hit: true; result: unknown } | { hit: false };

/** 前缀重放规划器：对相同 (scriptHash, argsHash) 的 prior journal，
 *  按 (seq, specHash) 逐调用判定命中；首个不命中（规格变更 / 新增调用 / prior 非 completed）
 *  起整条尾部失效——下游规格可能经宿主 ${prev} 插值依赖上游结果，越过缺口复用不安全（spec §2.1/§7）。*/
export class ResumePlanner {
  private readonly bySeq = new Map<number, JournalRow>();
  private broken = false;
  private hits = 0;

  constructor(prior: readonly JournalRow[]) {
    for (const r of prior) this.bySeq.set(r.seq, r);
  }

  consult(seq: number, specHash: string): ConsultResult {
    if (this.broken) return { hit: false };
    const prior = this.bySeq.get(seq);
    if (!prior || prior.specHash !== specHash || prior.status !== "completed") {
      this.broken = true;
      return { hit: false };
    }
    this.hits += 1;
    return { hit: true, result: prior.resultJson };
  }

  get cacheHits(): number {
    return this.hits;
  }
}

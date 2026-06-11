// RepoMap 类型（借 aider repomap.py 算法，TS 重写；NOTICE 归因）。
export type TagKind = "def" | "ref";
export type Tag = {
  relPath: string;
  name: string; // 标识符
  kind: TagKind;
  line: number; // 0-based
};

export type RepoMapEntry = { relPath: string; rank: number; lines: number[]; names: string[] };

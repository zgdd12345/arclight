// SEARCH/REPLACE 块解析（借 aider editblock_coder.py 语义，TS 重写；Apache-2.0 归因见 NOTICE）。
// 格式（marker 5-9 个字符容错）：
//   path/to/file.ts
//   <<<<<<< SEARCH
//   原文
//   =======
//   新文
//   >>>>>>> REPLACE

export type EditBlock = { filePath: string; search: string; replace: string };
export type ParseResult = { ok: true; blocks: EditBlock[] } | { ok: false; reason: string };

const HEAD_RE = /^<{5,9}\s*SEARCH\s*$/;
const DIVIDER_RE = /^={5,9}\s*$/;
const UPDATED_RE = /^>{5,9}\s*REPLACE\s*$/;

export function parseEditBlocks(text: string): ParseResult {
  const lines = text.split("\n");
  const blocks: EditBlock[] = [];
  let i = 0;
  let lastFilePath: string | null = null;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!HEAD_RE.test(line.trim())) {
      i++;
      continue;
    }
    // 文件名：向上找最近的非空行（跳过 ``` 围栏与块 marker 行）
    let filePath: string | null = null;
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
      const raw = (lines[j] ?? "").trim();
      if (raw === "" || raw.startsWith("```")) continue;
      if (HEAD_RE.test(raw) || DIVIDER_RE.test(raw) || UPDATED_RE.test(raw)) break; // 上一块的尾部 → 用 lastFilePath
      const cand = raw.replace(/^`+|`+$/g, "").replace(/^\*+|\*+$/g, "");
      if (cand === "") continue;
      filePath = cand;
      break;
    }
    filePath = filePath ?? lastFilePath;
    if (!filePath) return { ok: false, reason: `SEARCH block at line ${i + 1} has no file path` };
    lastFilePath = filePath;

    // 收集 search 段
    i++;
    const search: string[] = [];
    while (i < lines.length && !DIVIDER_RE.test((lines[i] ?? "").trim())) {
      if (UPDATED_RE.test((lines[i] ?? "").trim())) {
        return { ok: false, reason: `missing ======= divider before REPLACE (line ${i + 1})` };
      }
      search.push(lines[i] ?? "");
      i++;
    }
    if (i >= lines.length) return { ok: false, reason: "unterminated SEARCH block (no =======)" };

    // 收集 replace 段
    i++;
    const replace: string[] = [];
    while (i < lines.length && !UPDATED_RE.test((lines[i] ?? "").trim())) {
      if (HEAD_RE.test((lines[i] ?? "").trim())) {
        return { ok: false, reason: `missing >>>>>>> REPLACE before next SEARCH (line ${i + 1})` };
      }
      replace.push(lines[i] ?? "");
      i++;
    }
    if (i >= lines.length) {
      return { ok: false, reason: "unterminated block (no >>>>>>> REPLACE)" };
    }
    i++;
    blocks.push({
      filePath,
      search: search.join("\n"),
      replace: replace.join("\n"),
    });
  }

  if (blocks.length === 0) return { ok: false, reason: "no SEARCH/REPLACE blocks found" };
  return { ok: true, blocks };
}

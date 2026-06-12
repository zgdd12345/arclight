import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tag } from "./types";

// Tag 抽取：优先 web-tree-sitter（精确 AST），不可用则正则粗提取（R2 降级，降精度不阻断）。
// WASM 坑：Parser.init() 全局一次；每语言 Language.load 一次；tree.delete() 必调（WASM 无 GC）。

let parserInitPromise: Promise<unknown> | null = null;
// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter 动态加载，类型在运行时确定
let TS: { Parser: any; Language: any } | null = null;
// biome-ignore lint/suspicious/noExplicitAny: 同上
let tsLang: any = null;

async function ensureParser(): Promise<boolean> {
  if (TS && tsLang) return true;
  try {
    if (!parserInitPromise) {
      parserInitPromise = (async () => {
        const mod = await import("web-tree-sitter");
        await mod.Parser.init();
        TS = { Parser: mod.Parser, Language: mod.Language };
        const wasmCandidates = [
          // bun workspace 解析路径
          new URL(
            "../../../../node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm",
            import.meta.url,
          ).pathname,
          "node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm",
        ];
        for (const w of wasmCandidates) {
          if (await Bun.file(w).exists()) {
            tsLang = await TS.Language.load(w);
            break;
          }
        }
      })();
    }
    await parserInitPromise;
    return tsLang !== null;
  } catch {
    return false;
  }
}

// camelCase / snake / kebab 顶层标识符（粗略足够喂图）
const IDENT_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
const DEF_RE =
  /\b(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)|\b([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=\s*(?:async\s*)?\(|\([^)]*\)\s*(?::[^={]+)?\{)/g;
const KEYWORDS = new Set([
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "const",
  "let",
  "var",
  "return",
  "if",
  "else",
  "for",
  "while",
  "import",
  "export",
  "from",
  "default",
  "async",
  "await",
  "new",
  "this",
  "true",
  "false",
  "null",
  "undefined",
  "void",
  "string",
  "number",
  "boolean",
  "any",
  "unknown",
  "extends",
  "implements",
  "public",
  "private",
  "protected",
  "static",
  "readonly",
  "as",
  "of",
  "in",
  "typeof",
]);

// 选择最佳抽取结果：AST 为 null 或空数组时均降级至正则（空数组等同失败，防止静默空走屏蔽 regex）
export function selectExtractResult(viaAst: Tag[] | null, regexFallback: () => Tag[]): Tag[] {
  if (viaAst !== null && viaAst.length > 0) return viaAst;
  return regexFallback();
}

export async function extractTags(repoRoot: string, relPath: string): Promise<Tag[]> {
  let src: string;
  try {
    src = readFileSync(join(repoRoot, relPath), "utf8");
  } catch {
    return [];
  }
  if (await ensureParser()) {
    const viaAst = extractViaTreeSitter(src, relPath);
    return selectExtractResult(viaAst, () => extractViaRegex(src, relPath)); // AST 空时也降级
  }
  return extractViaRegex(src, relPath); // R2 降级
}

function extractViaTreeSitter(src: string, relPath: string): Tag[] | null {
  if (!TS || !tsLang) return null;
  try {
    const parser = new TS.Parser();
    parser.setLanguage(tsLang);
    const tree = parser.parse(src);
    if (!tree) return null;
    const tags: Tag[] = [];
    // 简化遍历：def = 命名声明节点；ref = identifier 引用
    const DEF_TYPES = new Set([
      "function_declaration",
      "class_declaration",
      "interface_declaration",
      "type_alias_declaration",
      "enum_declaration",
      "method_definition",
      "public_field_definition",
      "variable_declarator",
    ]);
    const walk = (node: {
      type: string;
      namedChildren: unknown[];
      childForFieldName(f: string): unknown;
      startPosition: { row: number };
    }) => {
      if (DEF_TYPES.has(node.type)) {
        const nameNode = node.childForFieldName("name") as {
          text: string;
          startPosition: { row: number };
        } | null;
        if (nameNode?.text) {
          tags.push({
            relPath,
            name: nameNode.text,
            kind: "def",
            line: nameNode.startPosition.row,
          });
        }
      }
      if (node.type === "identifier" || node.type === "type_identifier") {
        const n = node as unknown as { text: string; startPosition: { row: number } };
        if (n.text && !KEYWORDS.has(n.text)) {
          tags.push({ relPath, name: n.text, kind: "ref", line: n.startPosition.row });
        }
      }
      for (const c of node.namedChildren) walk(c as never);
    };
    walk(tree.rootNode as never);
    tree.delete(); // WASM 无 GC，必调
    return tags;
  } catch {
    return null;
  }
}

export function extractViaRegex(src: string, relPath: string): Tag[] {
  const tags: Tag[] = [];
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    DEF_RE.lastIndex = 0;
    let m = DEF_RE.exec(line);
    while (m) {
      const name = m[1] ?? m[2];
      if (name && !KEYWORDS.has(name)) tags.push({ relPath, name, kind: "def", line: i });
      m = DEF_RE.exec(line);
    }
    IDENT_RE.lastIndex = 0;
    let r = IDENT_RE.exec(line);
    while (r) {
      const name = r[1];
      if (name && !KEYWORDS.has(name) && name.length > 1) {
        tags.push({ relPath, name, kind: "ref", line: i });
      }
      r = IDENT_RE.exec(line);
    }
  });
  return tags;
}

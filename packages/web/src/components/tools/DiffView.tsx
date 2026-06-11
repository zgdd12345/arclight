"use client";

// DiffView —— diff 台架仪器（DEV_PLAN §2.2 ③「分期降级：先 pre 后 Monaco」）。
//
// 设计纪律（DESIGN.md「信任面纪律」§4「diff 必须可长读」）：
//   新增 = 暖鼠尾草 --positive 底纹；删除 = 去饱和灰烬 --del-ash + 删除线；
//   绝不用糖果红绿。Monaco 主题套碳黑 token（--base 背景 / hairline gutter）。
//
// 真懒加载（DEV_PLAN R5「首屏 bundle 膨胀」纪律）：
//   1) `dynamic(() => import("@monaco-editor/react"), { ssr:false })` 把 Monaco
//      切成独立 chunk；
//   2) IntersectionObserver 把 dynamic 组件的「渲染」门控在「卡片进视口」之后——
//      故 Monaco chunk 的网络请求也只在进视口时才发生。
//   3) Monaco onMount 之前一律渲染 <pre> 着色降级视图。
//
// 诚实纪律：当前内核 tool 只回传 preview 文本，diff 的完整 before/after 常拿不到。
//   本组件不硬造前后内容——
//   · SEARCH/REPLACE 或 unified patch → 解析出「变更段」喂 Monaco（仅变更段）；
//   · write_file → 只有新内容，全部视为新增（无 before）；
//   · 解析不出结构（argsPreview 仅为短预览）→ 原样着色渲染 patch 文本。
//   卡片底部恒标注数据来源，不假装拥有完整文件。

import dynamic from "next/dynamic";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";

// Monaco 类型仅用于注解（编译期擦除，不进运行时 bundle）。
type MonacoNs = typeof import("monaco-editor");

// 真懒：dynamic + ssr:false 使 @monaco-editor/react 落独立 chunk，
// 仅当 <DiffEditor> 实际被渲染（= 进视口）时才发起 import。
const DiffEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), {
  ssr: false,
});

const CARBON_THEME = "carbon-arc";

type LineKind = "add" | "del" | "ctx" | "meta";
type DiffLine = { kind: LineKind; text: string };
type DiffSource = "search-replace" | "unified" | "write" | "raw";

type ParsedDiff = {
  source: DiffSource;
  lines: DiffLine[];
  original: string; // Monaco 左（before / 变更前段）
  modified: string; // Monaco 右（after / 变更后段）
  note: string; // 诚实标注（数据来源）
};

const SEARCH_OPEN = /^<{5,9}\s*SEARCH\s*$/;
const DIVIDER = /^={5,9}\s*$/;
const REPLACE_CLOSE = /^>{5,9}\s*REPLACE\s*$/;

// SEARCH/REPLACE 块解析（aider editblock 格式，5-9 字符栅栏容错，借 DEV_PLAN §2.3 ②）。
function parseSearchReplace(text: string): ParsedDiff | null {
  const raw = text.split("\n");
  const lines: DiffLine[] = [];
  const orig: string[] = [];
  const mod: string[] = [];
  let state: "idle" | "search" | "replace" = "idle";
  let found = false;

  for (const ln of raw) {
    if (state === "idle" && SEARCH_OPEN.test(ln)) {
      state = "search";
      found = true;
      lines.push({ kind: "meta", text: ln });
      continue;
    }
    if (state === "search" && DIVIDER.test(ln)) {
      state = "replace";
      lines.push({ kind: "meta", text: ln });
      continue;
    }
    if (state === "replace" && REPLACE_CLOSE.test(ln)) {
      state = "idle";
      lines.push({ kind: "meta", text: ln });
      continue;
    }
    if (state === "search") {
      lines.push({ kind: "del", text: ln });
      orig.push(ln);
    } else if (state === "replace") {
      lines.push({ kind: "add", text: ln });
      mod.push(ln);
    } else {
      // 块外文本（如文件名提示行）作 meta。
      lines.push({ kind: "meta", text: ln });
    }
  }

  if (!found) return null;
  return {
    source: "search-replace",
    lines,
    original: orig.join("\n"),
    modified: mod.join("\n"),
    note: "基于 patch 文本 · SEARCH/REPLACE 仅变更段（非完整文件）",
  };
}

// unified / apply_patch（opencode·cline 格式）解析：+ 新增 / - 删除 / 空格 上下文。
function parseUnified(text: string): ParsedDiff | null {
  const raw = text.split("\n");
  const lines: DiffLine[] = [];
  const orig: string[] = [];
  const mod: string[] = [];
  let signal = false;

  for (const ln of raw) {
    if (ln.startsWith("*** ") || ln.startsWith("@@")) {
      lines.push({ kind: "meta", text: ln });
      signal = true;
      continue;
    }
    if (ln.startsWith("+++") || ln.startsWith("---")) {
      lines.push({ kind: "meta", text: ln });
      continue;
    }
    if (ln.startsWith("+")) {
      const body = ln.slice(1);
      lines.push({ kind: "add", text: body });
      mod.push(body);
      signal = true;
    } else if (ln.startsWith("-")) {
      const body = ln.slice(1);
      lines.push({ kind: "del", text: body });
      orig.push(body);
      signal = true;
    } else {
      const body = ln.startsWith(" ") ? ln.slice(1) : ln;
      lines.push({ kind: "ctx", text: body });
      orig.push(body);
      mod.push(body);
    }
  }

  if (!signal) return null;
  return {
    source: "unified",
    lines,
    original: orig.join("\n"),
    modified: mod.join("\n"),
    note: "基于 patch 文本 · unified 变更段（非完整文件）",
  };
}

function parseDiff(text: string, toolName: string): ParsedDiff {
  const body = text ?? "";

  const sr = parseSearchReplace(body);
  if (sr) return sr;

  const uni = parseUnified(body);
  if (uni) return uni;

  // write_file：只有新内容，无 before——全部视为新增，不硬造前文。
  if (toolName === "write_file" && body.trim()) {
    const lines: DiffLine[] = body.split("\n").map((t) => ({ kind: "add", text: t }));
    return {
      source: "write",
      lines,
      original: "",
      modified: body,
      note: "基于 write_file 新内容 · 无 before，整体视为新增",
    };
  }

  // 兜底：拿不到结构化 diff（argsPreview 常为短预览）——原样渲染，诚实标注。
  const lines: DiffLine[] = body.split("\n").map((t) => ({ kind: "meta", text: t }));
  return {
    source: "raw",
    lines,
    original: "",
    modified: body,
    note: "基于 patch 文本预览 · 内核仅回传 preview，未含完整 before/after",
  };
}

// 行扩展名 → Monaco 语言（粗映射，仅影响高亮，无 before/after 不受影响）。
function guessLanguage(text: string): string {
  const m = text.match(/[\w./-]+\.(tsx?|jsx?|json|css|md|py|go|rs|sh|ya?ml|html?)\b/);
  const ext = m?.[1];
  if (!ext) return "plaintext";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    css: "css",
    md: "markdown",
    py: "python",
    go: "go",
    rs: "rust",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml",
    html: "html",
    htm: "html",
  };
  return map[ext] ?? "plaintext";
}

// 读运行时 CSS 令牌（尊重 light/dark 当前态）。globals.css 输出 6 位 hex。
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const stripHash = (h: string) => h.replace(/^#/, "");
const withHash = (h: string) => (h.startsWith("#") ? h : `#${h}`);
// hex + alpha（Monaco colors 接受 8 位 #RRGGBBAA）。
const alpha = (h: string, aa: string) => `${withHash(h).slice(0, 7)}${aa}`;

// 注册 carbon 主题：背景 --base，新增 --positive 底纹，删除 --del-ash 底纹，
// gutter/行号 hairline。删除线感由底纹 + 去饱和灰烬色承担（<pre> 降级层有真删除线）。
function defineCarbonTheme(monaco: MonacoNs) {
  const isLight =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "light";

  const base = withHash(cssVar("--base", "#14110e"));
  const text = withHash(cssVar("--text", "#ece3d4"));
  const muted = withHash(cssVar("--muted", "#9a8f7f"));
  const hairline = withHash(cssVar("--hairline", "#3a3128"));
  const positive = withHash(cssVar("--positive", "#7fb069"));
  const delAsh = withHash(cssVar("--del-ash", "#6b5f52"));

  monaco.editor.defineTheme(CARBON_THEME, {
    base: isLight ? "vs" : "vs-dark",
    inherit: true,
    rules: [{ token: "", foreground: stripHash(text), background: stripHash(base) }],
    colors: {
      "editor.background": base,
      "editor.foreground": text,
      "editorLineNumber.foreground": muted,
      "editorLineNumber.activeForeground": text,
      "editorGutter.background": base,
      "editorIndentGuide.background1": hairline,
      "editor.lineHighlightBackground": base,
      "editorWidget.background": base,
      "diffEditor.insertedLineBackground": alpha(positive, "26"),
      "diffEditor.insertedTextBackground": alpha(positive, "3a"),
      "diffEditor.removedLineBackground": alpha(delAsh, "26"),
      "diffEditor.removedTextBackground": alpha(delAsh, "3a"),
      "diffEditor.diagonalFill": alpha(hairline, "55"),
      "diffEditorGutter.insertedLineBackground": alpha(positive, "1f"),
      "diffEditorGutter.removedLineBackground": alpha(delAsh, "1f"),
      "editorOverviewRuler.border": "#00000000",
    },
  });
}

function lineStyle(kind: LineKind): CSSProperties {
  switch (kind) {
    case "add":
      return {
        color: "var(--positive)",
        backgroundColor: "color-mix(in srgb, var(--positive) 12%, transparent)",
      };
    case "del":
      return {
        color: "var(--del-ash)",
        backgroundColor: "color-mix(in srgb, var(--del-ash) 12%, transparent)",
        textDecoration: "line-through",
      };
    case "ctx":
      return { color: "var(--text)" };
    default:
      return { color: "var(--muted)" };
  }
}

function linePrefix(kind: LineKind): string {
  if (kind === "add") return "+ ";
  if (kind === "del") return "- ";
  if (kind === "ctx") return "  ";
  return "";
}

// 分期降级第一期：<pre> 着色行 diff（鼠尾草新增 / 灰烬删除 + 删除线）。
function PreDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="max-h-80 overflow-auto px-3 py-2 text-[12px] leading-[1.5]">
      {lines.map((l, i) => (
        <div
          // diff 行无稳定 id，index 作 key（静态渲染、无重排）。
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态 diff 行无天然 id
          key={i}
          className="whitespace-pre-wrap break-words"
          style={lineStyle(l.kind)}
        >
          {l.kind === "meta" ? l.text : `${linePrefix(l.kind)}${l.text || " "}`}
        </div>
      ))}
    </pre>
  );
}

export function DiffView({ text, toolName }: { text: string; toolName: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [monacoReady, setMonacoReady] = useState(false);

  const parsed = useMemo(() => parseDiff(text, toolName), [text, toolName]);
  const language = useMemo(() => guessLanguage(text), [text]);

  // IntersectionObserver：仅当卡片进视口才放行 Monaco 渲染（→ 触发 chunk import）。
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setInView(true);
            obs.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView]);

  // Monaco 能给完整 side-by-side 的条件：存在结构化变更段（raw/空内容无意义）。
  const monacoUseful =
    parsed.source !== "raw" && (parsed.original !== "" || parsed.modified !== "");

  const editorHeight = useMemo(() => {
    const rows = Math.max(parsed.original.split("\n").length, parsed.modified.split("\n").length);
    return Math.min(Math.max(rows, 3), 28) * 19 + 14;
  }, [parsed]);

  return (
    <div ref={ref}>
      {/* 第一期降级：Monaco 未 ready 前恒显 <pre> 着色视图 */}
      {!monacoReady ? <PreDiff lines={parsed.lines} /> : null}

      {/* 第二期：进视口后挂载 Monaco；ready 前隐藏（仅为触发加载），ready 后切 side-by-side */}
      {inView && monacoUseful ? (
        <div style={{ height: editorHeight, display: monacoReady ? "block" : "none" }}>
          <DiffEditor
            theme={CARBON_THEME}
            language={language}
            original={parsed.original}
            modified={parsed.modified}
            beforeMount={defineCarbonTheme}
            onMount={() => setMonacoReady(true)}
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 19,
              renderOverviewRuler: false,
              automaticLayout: true,
              renderLineHighlight: "none",
              guides: { indentation: false },
            }}
          />
        </div>
      ) : null}

      {/* 诚实标注：数据来源恒可见，不假装拥有完整 before/after */}
      <div
        className="border-t px-3 py-1 text-[11px] text-muted"
        style={{ borderColor: "var(--hairline)", fontFamily: "var(--font-mono)" }}
      >
        {parsed.note}
      </div>
    </div>
  );
}

// 原生模块探测（供 scripts/smoke-test-native.ts 调用）。
// 必须住在 core 包内：node-pty / web-tree-sitter 是 core 的依赖，
// bun workspace 将其装在 packages/core/node_modules，从根工作区无法解析。

export type NativeCheck = { ok: boolean; detail: string };

export async function checkNodePty(): Promise<NativeCheck> {
  try {
    const pty = await import("node-pty");
    const data = await new Promise<string>((resolve, reject) => {
      const p = pty.spawn("/bin/sh", ["-c", "echo pty-ok; sleep 0.3"], {
        name: "xterm",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
      });
      let buf = "";
      const timer = setTimeout(() => reject(new Error("pty timeout 5s")), 5000);
      p.onData((d: string) => {
        buf += d;
      });
      p.onExit(() => {
        clearTimeout(timer);
        resolve(buf);
      });
    });
    return data.includes("pty-ok")
      ? { ok: true, detail: "spawn+onData+onExit ok under Bun" }
      : { ok: false, detail: "pty spawned but produced no data" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function checkTreeSitter(): Promise<NativeCheck> {
  try {
    const { Parser, Language } = await import("web-tree-sitter");
    await Parser.init();
    // tree-sitter-typescript npm 包不带预编译 wasm；找得到就真解析，找不到如实报告
    const candidates = [
      import.meta.resolveSync?.("tree-sitter-typescript/tree-sitter-typescript.wasm"),
      "packages/core/node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm",
      "node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm",
    ].filter((p): p is string => typeof p === "string");
    let wasmPath: string | null = null;
    for (const c of candidates) {
      if (await Bun.file(c).exists()) {
        wasmPath = c;
        break;
      }
    }
    if (!wasmPath) {
      return {
        ok: false,
        detail:
          "core wasm init ok, but grammar wasm missing (tree-sitter-typescript ships no prebuilt wasm) — add prebuilt-wasm dep before slice5 (RepoMap)",
      };
    }
    const lang = await Language.load(wasmPath);
    const parser = new Parser();
    parser.setLanguage(lang);
    const src = Array.from(
      { length: 10 },
      (_, i) => `export function f${i}(): number { return ${i}; }`,
    ).join("\n");
    const tree = parser.parse(src);
    const ok = tree !== null && tree.rootNode.type === "program";
    tree?.delete(); // WASM 无 GC，必调
    return ok
      ? { ok: true, detail: `parsed 10-line TS via ${wasmPath}` }
      : { ok: false, detail: "parse returned unexpected tree" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

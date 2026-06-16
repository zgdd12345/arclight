import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scriptHash } from "./hash";
// 共享类型一律 import 自 M0 唯一权威 ./types（不本地重声明）。
import type { LoadedWorkflow, WorkflowStorePort } from "./types";

// 命名 workflow 持久层（spec §3 store.ts）。
// 安全要点（spec §10）：name 是唯一进入文件系统路径的外部输入，用严格 slug 正则收口——
// 正则禁掉 `/`、`.`、`..`、大写、空格，故天然无路径穿越（无需再 resolve + startsWith 比对）。
export const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUFFIX = ".workflow.js";

// implements WorkflowStorePort（M0 端口）——结构化满足，供 M6 createWorkflowRuntime 注入。
export class WorkflowStore implements WorkflowStorePort {
  private readonly dir: string;

  constructor(arclightDir: string) {
    this.dir = join(arclightDir, "workflows");
  }

  /** scriptHash：M3 resume 缓存键的一半（另一半是 args，spec §7）。委托给 hash.ts 规范实现保证唯一性。 */
  static hashScript(source: string): string {
    return scriptHash(source);
  }

  private assertName(name: string): void {
    if (!WORKFLOW_NAME_RE.test(name)) {
      throw new Error(`invalid workflow name: ${JSON.stringify(name)}`);
    }
  }

  private pathFor(name: string): string {
    this.assertName(name);
    return join(this.dir, `${name}${SUFFIX}`);
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(SUFFIX))
      .map((f) => f.slice(0, -SUFFIX.length))
      .filter((n) => WORKFLOW_NAME_RE.test(n))
      .sort();
  }

  has(name: string): boolean {
    if (!WORKFLOW_NAME_RE.test(name)) return false;
    return existsSync(join(this.dir, `${name}${SUFFIX}`));
  }

  load(name: string): LoadedWorkflow {
    const path = this.pathFor(name);
    if (!existsSync(path)) throw new Error(`no such workflow: ${name}`);
    const source = readFileSync(path, "utf8");
    return { name, source, scriptHash: WorkflowStore.hashScript(source) };
  }

  /** 原子保存：写临时文件后 rename，避免并发/崩溃留半截文件。 */
  save(name: string, source: string): { name: string; scriptHash: string } {
    const path = this.pathFor(name);
    if (typeof source !== "string" || source.length === 0) {
      throw new Error("workflow source must be a non-empty string");
    }
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${name}.${randomUUID()}.tmp`);
    writeFileSync(tmp, source, "utf8");
    renameSync(tmp, path);
    return { name, scriptHash: WorkflowStore.hashScript(source) };
  }
}

/**
 * 命名 vs 临场合成判定（spec §1/§3）——M5 的解析唯一收口点；M6 公开 runWorkflow 复用之。
 * - slug 形（单 token，匹配 WORKFLOW_NAME_RE）→ 视为命名 workflow，从 store 载入；
 *   不存在则抛错（不把裸标识符当脚本跑，安全优先）。
 * - 其余（含 `(`/`;`/换行的合成脚本）→ 视为临场生成的内联源码，原样返回。
 */
export function resolveWorkflowSource(scriptOrName: string, store: WorkflowStore): string {
  const candidate = scriptOrName.trim();
  if (WORKFLOW_NAME_RE.test(candidate)) {
    try {
      return store.load(candidate).source;
    } catch {
      throw new Error(`no such named workflow: ${candidate}`);
    }
  }
  return scriptOrName;
}

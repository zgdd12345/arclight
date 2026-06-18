import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_NAME_RE } from "./store";

const SUFFIX = ".workflow.js";

export type WorkflowTemplate = { name: string; source: string };

/** Read-only reference workflows shipped under <arclightDir>/workflows/templates/.
 *  Surfaced to a designing agent so it can model a new dynamic workflow on a known-good
 *  shape. Distinct from WorkflowStore (which holds runnable saved workflows). */
export class TemplateStore {
  private readonly dir: string;

  constructor(arclightDir: string) {
    this.dir = join(arclightDir, "workflows", "templates");
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

  load(name: string): WorkflowTemplate {
    if (!WORKFLOW_NAME_RE.test(name)) throw new Error(`no such template: ${name}`);
    const path = join(this.dir, `${name}${SUFFIX}`);
    if (!existsSync(path)) throw new Error(`no such template: ${name}`);
    return { name, source: readFileSync(path, "utf8") };
  }
}

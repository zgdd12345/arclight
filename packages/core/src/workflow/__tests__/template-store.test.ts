import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TemplateStore } from "../template-store";

describe("TemplateStore", () => {
  let arclightDir: string;
  let templatesDir: string;

  beforeEach(() => {
    arclightDir = mkdtempSync(join(tmpdir(), "arclight-tmpl-"));
    templatesDir = join(arclightDir, "workflows", "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "fanout-review.workflow.js"), "const r = agent('x'); r;", "utf8");
    writeFileSync(join(templatesDir, "two-stage.workflow.js"), "phase('a'); agent('b');", "utf8");
  });
  afterEach(() => rmSync(arclightDir, { recursive: true, force: true }));

  test("list returns sorted template names without suffix", () => {
    const store = new TemplateStore(arclightDir);
    expect(store.list()).toEqual(["fanout-review", "two-stage"]);
  });

  test("load returns name + source", () => {
    const store = new TemplateStore(arclightDir);
    expect(store.load("fanout-review")).toEqual({
      name: "fanout-review",
      source: "const r = agent('x'); r;",
    });
  });

  test("has is false for missing or invalid names", () => {
    const store = new TemplateStore(arclightDir);
    expect(store.has("two-stage")).toBe(true);
    expect(store.has("missing")).toBe(false);
    expect(store.has("Bad Name")).toBe(false);
  });

  test("load throws for a missing template", () => {
    const store = new TemplateStore(arclightDir);
    expect(() => store.load("missing")).toThrow("no such template: missing");
  });

  test("list returns [] when templates dir does not exist", () => {
    const empty = mkdtempSync(join(tmpdir(), "arclight-empty-"));
    expect(new TemplateStore(empty).list()).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});

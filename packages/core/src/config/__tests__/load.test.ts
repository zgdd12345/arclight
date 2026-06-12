// loadConfig：devNoAuth / projectsRoot 走 ConfigSchema 统一解析（FINDING 9）。
// 验证默认关闭、精确 "=1" 语义，以及 projectsRoot 默认 = repoPath 父目录 / env 覆盖。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadConfig } from "../load";

const REPO = "/tmp/arclight-cfg-test/repo";

// 隔离这些 env，避免污染其他用例；每个用例后还原。
const KEYS = [
  "ARCLIGHT_DEV_NO_AUTH",
  "ARCLIGHT_PROJECTS_ROOT",
  "ANTHROPIC_API_KEY",
  "ZHIPU_API_KEY",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "test-key"; // 满足 schema 必填
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadConfig devNoAuth / projectsRoot", () => {
  test("默认 devNoAuth=false，projectsRoot=repoPath 父目录", () => {
    const cfg = loadConfig(REPO);
    expect(cfg.devNoAuth).toBe(false);
    expect(cfg.projectsRoot).toBe(resolve(REPO, ".."));
  });

  test('ARCLIGHT_DEV_NO_AUTH="1" → devNoAuth=true', () => {
    process.env.ARCLIGHT_DEV_NO_AUTH = "1";
    expect(loadConfig(REPO).devNoAuth).toBe(true);
  });

  test.each(["0", "true", "yes", ""])('ARCLIGHT_DEV_NO_AUTH=%p（非 "1"）→ false', (v) => {
    process.env.ARCLIGHT_DEV_NO_AUTH = v;
    expect(loadConfig(REPO).devNoAuth).toBe(false);
  });

  test("ARCLIGHT_PROJECTS_ROOT 显式指定 → 解析为绝对路径", () => {
    process.env.ARCLIGHT_PROJECTS_ROOT = "/srv/projects";
    expect(loadConfig(REPO).projectsRoot).toBe("/srv/projects");
  });
});

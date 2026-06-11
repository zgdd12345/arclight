import { describe, expect, test } from "bun:test";
import type { Tool } from "@arclight/protocol";
import { z } from "zod";
import { checkBlacklist, classify } from "../presets";

function mkTool(
  name: string,
  tier: "safe" | "confirm" | "admin_only",
  cls: "read" | "write" | "irreversible" | "funds",
): Tool<unknown, unknown> {
  return {
    meta: {
      name,
      description: "",
      isReadOnly: cls === "read",
      isConcurrencySafe: cls === "read",
      riskTier: tier,
      riskClass: cls,
      timeoutMs: 1000,
      maxResultSizeBytes: 1024,
    },
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async () => ({}),
  };
}

describe("黑名单（命中即永拒，不弹审批）", () => {
  test.each([
    ["sudo rm -rf /", "sudo"],
    ["su root", "提权"],
    ["rm -rf ~", "家目录"],
    ["rm -rf $HOME/stuff", "家目录"],
    ["cat ~/.ssh/id_rsa", "SSH"],
    ["ssh user@host", "ssh"],
    ["scp f host:/p", "ssh"],
    ["cat ~/.aws/credentials", "凭证"],
    ["docker -H unix:///var/run/docker.sock ps", "docker"],
    ["security find-generic-password -s x", "密钥"],
    // —— Codex 对抗式发现的旁路（修复后必须拒绝）——
    ["true; sudo id", "复合命令藏 sudo"],
    ["echo hi && sudo reboot", "&& 后 sudo"],
    ["ls || ssh evil@host", "|| 后 ssh"],
    ["cat foo | ssh host", "管道后 ssh"],
    ["sh -c 'ssh host'", "sh -c 内层 ssh"],
    ["bash -c 'sudo id'", "bash -c 内层 sudo"],
    ["rm -r -f /", "分开 flag rm 根"],
    ["rm -R -f ~", "分开 flag rm 家"],
    ["cat .ssh/id_rsa", "相对 .ssh"],
    ["cp .aws/credentials /tmp", "相对 .aws"],
  ])("拒绝: %s", (cmd) => {
    expect(checkBlacklist(cmd).blocked).toBe(true);
  });

  test.each([
    "ls -la",
    "npm test",
    "rm -rf build/",
    "rm -rf node_modules",
    "rm -r -f build/", // 分开 flag 但目标是普通目录 → 放行
    "git status",
    "grep ssh README.md",
    "echo 'a; b'", // 引号内分号误拆产生的段不匹配 → 放行
    "cat assh.txt", // .ssh 子串但非路径 → 放行
  ])("放行: %s", (cmd) => {
    expect(checkBlacklist(cmd).blocked).toBe(false);
  });
});

describe("classify 风险分级", () => {
  test("safe+read → auto-allow", () => {
    expect(classify(mkTool("read_file", "safe", "read"), { path: "a.ts" }).kind).toBe("auto-allow");
  });

  test("confirm+write → ask（med 风险）", () => {
    const d = classify(mkTool("write_file", "confirm", "write"), { path: "a.ts" });
    expect(d).toMatchObject({ kind: "ask", risk: "med", cls: "write" });
  });

  test("admin_only 默认拒绝", () => {
    expect(classify(mkTool("danger", "admin_only", "irreversible"), {}).kind).toBe("deny");
  });

  test("admin_only + dangerFullAccess → ask（high）", () => {
    const d = classify(
      mkTool("danger", "admin_only", "irreversible"),
      {},
      { dangerFullAccess: true },
    );
    expect(d).toMatchObject({ kind: "ask", risk: "high" });
  });

  test("bash 命中黑名单 → deny（即便 tier=confirm）", () => {
    const d = classify(mkTool("bash", "confirm", "write"), { command: "sudo reboot" });
    expect(d.kind).toBe("deny");
  });

  test("bash 正常命令 → ask，action=命令全文", () => {
    const d = classify(mkTool("bash", "confirm", "write"), { command: "npm test" });
    expect(d).toMatchObject({ kind: "ask", action: "npm test" });
  });
});

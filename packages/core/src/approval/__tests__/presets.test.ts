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
  ])("拒绝: %s", (cmd) => {
    expect(checkBlacklist(cmd).blocked).toBe(true);
  });

  test.each([
    "ls -la",
    "npm test",
    "rm -rf build/",
    "rm -rf node_modules",
    "git status",
    "grep ssh README.md",
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

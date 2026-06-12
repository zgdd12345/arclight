import { describe, expect, test } from "bun:test";
import type { Tool } from "@arclight/protocol";
import { z } from "zod";
import { checkBlacklist, classify } from "../presets";

function mkTool(
  name: string,
  tier: "safe" | "confirm" | "admin_only",
  cls: "read" | "write" | "irreversible" | "funds",
  opts: { executesShellCommands?: boolean } = {},
): Tool<unknown, unknown> {
  return {
    meta: {
      name,
      description: "",
      isReadOnly: cls === "read",
      isConcurrencySafe: cls === "read",
      // 默认按约定：名为 bash 的工具是命令执行器；其余可经 opts 显式覆盖（验证 capability 驱动）
      executesShellCommands: opts.executesShellCommands ?? name === "bash",
      mutatesWorkspace: cls !== "read",
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
    // —— 第二轮对抗：四类已验证旁路（shell-quote 分词确认）——
    ["bash -lc 'sudo id'", "组合 flag -lc 内层 sudo"],
    ["bash -cx 'ssh host'", "组合 flag -cx 内层 ssh"],
    ["true & sudo id", "& 后 sudo（后台分隔符）"],
    ["sleep 1 & ssh host", "& 后 ssh"],
    ["echo $(sudo id)", "$() 命令替换体藏 sudo"],
    ["echo `sudo id`", "反引号命令替换体藏 sudo"],
    ["echo $(echo $(ssh host))", "嵌套 $() 藏 ssh"],
    ["env sudo id", "env 前缀启动器后 sudo"],
    ["nohup env sudo id", "nohup env 链式前缀后 sudo"],
    ["timeout 5 sudo id", "timeout 数值参数后 sudo"],
    ["nice -n 10 ssh host", "nice 选项+数值后 ssh"],
    ["FOO=bar sudo id", "VAR=val 赋值前缀后 sudo"],
    ["env bash -lc 'sudo id'", "env + 组合 flag 内层 sudo"],
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
    "env NODE_ENV=test npm test", // env + 赋值启动器但真实命令 npm 无害 → 放行
    "timeout 30 npm run build", // timeout 数值参数后是 npm → 放行
    "nohup node server.js", // nohup 后是 node → 放行
    "echo $(git rev-parse HEAD)", // $() 替换体是 git → 放行
    "sleep 5 & echo done", // & 后是 echo → 放行
    "bash -lc 'npm test'", // 组合 flag 但内层 npm 无害 → 放行
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

  // 回归（capability 驱动，非 name 特判）：任何 executesShellCommands=true 的工具都套黑名单，
  // 即便名字不叫 "bash"——防未来的命令执行器静默绕过黑名单。
  test("非 bash 命令执行器（executesShellCommands=true）→ 黑名单照样命中 deny", () => {
    const tool = mkTool("run_shell", "confirm", "write", { executesShellCommands: true });
    expect(classify(tool, { command: "sudo reboot" }).kind).toBe("deny");
  });

  test("非命令工具（executesShellCommands=false）→ 不套黑名单，command 实参不触发 deny", () => {
    const tool = mkTool("write_file", "confirm", "write", { executesShellCommands: false });
    // 即便 args 恰带 command 字段，非命令执行器也不过黑名单 → 走正常审批而非 deny
    expect(classify(tool, { command: "sudo reboot" }).kind).toBe("ask");
  });
});

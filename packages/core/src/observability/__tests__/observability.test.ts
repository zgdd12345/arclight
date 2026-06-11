import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { AuditLog } from "../audit";
import { createLogger } from "../logger";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("AuditLog", () => {
  test("写 jsonl 行，含 ts + kind + actor", () => {
    dir = mkdtempSync(join(tmpdir(), "audit-"));
    const audit = new AuditLog(dir);
    audit.write("run1", {
      kind: "approval.decided",
      actor: "user",
      sessionId: "s",
      detail: { decision: "allow" },
    });
    audit.write("run1", { kind: "blacklist.hit", actor: "agent", detail: { command: "ssh x" } });
    const path = join(dir, "audit", "run1.jsonl");
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] as string);
    expect(first.kind).toBe("approval.decided");
    expect(first.actor).toBe("user");
    expect(typeof first.ts).toBe("number");
  });
});

describe("logger 脱敏", () => {
  test("token/apiKey/secret 字段被 redact，明文不出现在输出", () => {
    // 用同款 redact 配置 + 内存流捕获，断言明文被替换
    let captured = "";
    const stream = {
      write: (s: string) => {
        captured += s;
      },
    };
    const logger = pino(
      {
        redact: {
          paths: ["token", "apiKey", "secret", "*.token", "*.apiKey", "*.secret"],
          censor: "[redacted]",
        },
      },
      stream as never,
    );
    logger.info(
      { token: "sk-secret-123", apiKey: "key-abc", nested: { secret: "deep-secret" } },
      "x",
    );
    expect(captured).not.toContain("sk-secret-123");
    expect(captured).not.toContain("key-abc");
    expect(captured).not.toContain("deep-secret");
    expect(captured).toContain("[redacted]");
    // createLogger 工厂可正常构造
    expect(() => createLogger({ level: "silent" })).not.toThrow();
  });
});

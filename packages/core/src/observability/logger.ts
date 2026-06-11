import { pino } from "pino";

// pino 日志（DEV_PLAN §3.4）：dev pretty / 生产 NDJSON；serializers 脱敏 token/apiKey/secret。
// 不接 OTel/traceparent（OD-2，YAGNI——阶段一仅 pino + auditLog）。

const REDACT_PATHS = [
  "token",
  "apiKey",
  "anthropicApiKey",
  "zhipuApiKey",
  "secret",
  "authorization",
  "*.token",
  "*.apiKey",
  "*.secret",
  "*.authorization",
  "req.headers.authorization",
];

export function createLogger(opts: { dev?: boolean; level?: string } = {}) {
  return pino({
    level: opts.level ?? process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    ...(opts.dev
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss" },
          },
        }
      : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;

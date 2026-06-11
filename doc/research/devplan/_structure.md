Now I have all the context I need to produce the comprehensive monorepo structure document. Let me write it out.

---

# arclightagent 工程结构与 Monorepo 布局

> 严格对齐 5 份基础文档：ARCHITECTURE_BLUEPRINT / FULL_PLATFORM_DESIGN / 拿来即用选型清单 / P0 施工图 / P0 沙箱方案。MVP 阶段一 = Web + 写代码 + 本地优先 `arclight serve --repo`。

---

## 1. Bun Workspaces 包边界与职责

```
@arclight/protocol   类型层(ArcEvent / ArcCommand / ArcAck / ToolMeta / schema)
@arclight/core       内核(Hono server + 主循环 + ToolRegistry + 持久化 + 沙箱编排)
@arclight/client-core  端共享(reducer / SSE 重连 / discovery / useSession hook)
@arclight/web        Next.js App Router 前端(assistant-ui + ArcTransport + 权限 UI)
@arclight/cli        CLI 壳(后置 P2 占位,含 bun --compile 入口)
```

**包边界原则**

- `@arclight/protocol` 零运行时依赖，纯类型 + zod schema，所有包均可安全 import。
- `@arclight/core` 不 import 任何端包；所有工具、沙箱、ORM、主循环、SSE 路由全在此。
- `@arclight/client-core` 不 import `@arclight/core`，只 import `@arclight/protocol`；在 Node/Bun/浏览器三环境均可运行。
- `@arclight/web` 只通过 HTTP/SSE 与 core 通信（MVP 单 repo 可 `import type` from protocol，零 codegen）；不直接 import core 实现。
- `@arclight/cli` 是占位壳，P2 才实质填充。

---

## 2. 目录树（可直接照建）

```
arclightagent/
├── package.json                    # 根 workspace 聚合
├── bun.lock
├── biome.json
├── tsconfig.base.json
├── vitest.workspace.ts             # vitest workspace config
├── .env.example
├── .gitignore
├── NOTICE                          # Apache-2.0 归因(ai / drizzle / cline 摘录)
│
├── packages/
│   ├── protocol/                   # @arclight/protocol
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── events.ts           # ArcEvent union + subtypes
│   │       ├── commands.ts         # ArcCommand union (submit/interrupt/approve/declareCap/resume)
│   │       ├── ack.ts              # ArcAck (ok / error / stale-epoch)
│   │       ├── tool.ts             # ToolMeta / ToolContext / Tool<In,Out> / ToolErrorEnvelope
│   │       ├── capability.ts       # CapabilityProfile
│   │       ├── schema.ts           # zod schemas for all above
│   │       └── __tests__/
│   │           └── schema.test.ts
│   │
│   ├── core/                       # @arclight/core
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts            # 公开 API surface
│   │       ├── server/
│   │       │   ├── app.ts          # Hono app factory
│   │       │   ├── routes/
│   │       │   │   ├── commands.ts         # POST /api/commands (C1)
│   │       │   │   ├── events.ts           # GET /api/sessions/:id/events (C2 SSE)
│   │       │   │   ├── sessions.ts         # GET/DELETE /api/sessions
│   │       │   │   └── health.ts
│   │       │   ├── middleware/
│   │       │   │   ├── auth.ts             # loopback bearer + httpOnly cookie
│   │       │   │   └── requestContext.ts   # userId/tenantId/workspaceId 注入
│   │       │   └── serverJson.ts           # server.json 读写 (chmod 0600, owner check)
│   │       │
│   │       ├── agent/
│   │       │   ├── queryLoop.ts            # async-generator 主循环 (800-1500 行, agent 心脏)
│   │       │   ├── compaction.ts           # 单级压缩 (借 opencode MIT 模板)
│   │       │   ├── memory.ts               # MEMORY.md 读写 + session 注入
│   │       │   ├── provider.ts             # AI SDK adapter 层 (锁 ai minor, 收敛 adapter)
│   │       │   └── epochGuard.ts           # StaleEpochError + baseEpoch 检查
│   │       │
│   │       ├── tools/
│   │       │   ├── registry.ts             # ToolRegistry: 元数据/并发分批/输出投影
│   │       │   ├── builtin/
│   │       │   │   ├── readFile.ts
│   │       │   │   ├── writeFile.ts
│   │       │   │   ├── applyPatch.ts       # SEARCH/REPLACE + diff-match-patch
│   │       │   │   └── bash.ts             # nono 沙箱 + PTY
│   │       │   ├── mcp/
│   │       │   │   ├── adapter.ts          # MCP → 内核 Tool 适配器
│   │       │   │   ├── audit.ts            # Tool Poisoning 审计 + 白名单 (300-500 行)
│   │       │   │   └── credentialProxy.ts  # 凭证沙箱外代理
│   │       │   └── skill/
│   │       │       ├── loader.ts           # SKILL.md gray-matter 加载器
│   │       │       └── hooks.ts            # Hooks 分发
│   │       │
│   │       ├── coding/
│   │       │   ├── repoMap.ts              # RepoMapBuilder (graphology + pagerank, ~400 行)
│   │       │   ├── tagExtractor.ts         # web-tree-sitter TagExtractor (~150 行)
│   │       │   ├── editBlock.ts            # EditBlockParser + EditGuard (~280 行)
│   │       │   ├── checkpoint.ts           # CheckpointTracker (剥 VSCode 依赖, ~250 行)
│   │       │   └── pty.ts                  # PtyManager (~150 行)
│   │       │
│   │       ├── approval/
│   │       │   ├── service.ts              # ApprovalService 状态机
│   │       │   ├── presets.ts              # RiskTier presets + 黑名单 + shell-quote 分词
│   │       │   └── policy.ts               # safe/confirm/admin_only 路由
│   │       │
│   │       ├── sandbox/
│   │       │   ├── service.ts              # SandboxService interface + probe/run/cancel
│   │       │   ├── backends/
│   │       │   │   ├── localNono.ts        # nono spawn + profile 生成
│   │       │   │   ├── dockerFallback.ts
│   │       │   │   └── remoteVercel.ts     # opt-in, Vercel Sandbox SDK
│   │       │   └── profiles/
│   │       │       └── p0-local.json       # nono sandbox profile
│   │       │
│   │       ├── db/
│   │       │   ├── schema.ts               # 12 张表 Drizzle schema (来自 P0 施工图)
│   │       │   ├── client.ts               # drizzle(bun:sqlite) 单例
│   │       │   ├── migrate.ts              # drizzle-kit migrate runner
│   │       │   ├── appendEvent.ts          # seq 生成 (事务内: sessions.nextSeq → events insert)
│   │       │   ├── sseReplay.ts            # GET events?afterSeq=N&epoch=E 恢复逻辑
│   │       │   └── migrations/             # drizzle-kit 生成的 SQL 迁移文件
│   │       │
│   │       ├── artifacts/
│   │       │   └── store.ts                # ArtifactStore: 超限落盘 + spillRef
│   │       │
│   │       ├── usage/
│   │       │   └── tracker.ts              # usage 埋点 + quota + per-subagent 归因
│   │       │
│   │       ├── config/
│   │       │   └── load.ts                 # .env / .arclight/config.json 加载
│   │       │
│   │       ├── serve.ts                    # arclight serve --repo 入口
│   │       └── __tests__/
│   │           ├── golden/                 # ≥10 golden 编码 case (eval 红线)
│   │           │   ├── case-01-read-file.test.ts
│   │           │   ├── case-02-apply-patch.test.ts
│   │           │   ├── case-03-bash-safe.test.ts
│   │           │   └── ...
│   │           ├── queryLoop.test.ts
│   │           ├── approvalService.test.ts
│   │           └── sseReplay.test.ts
│   │
│   ├── client-core/                # @arclight/client-core
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── transport/
│   │       │   ├── sseTransport.ts     # SSE 连接 + 重连 + afterSeq/epoch 管理
│   │       │   └── httpClient.ts       # POST /api/commands fetch wrapper
│   │       ├── store/
│   │       │   ├── reducer.ts          # ArcEvent → UIState reducer (纯函数)
│   │       │   └── sessionStore.ts     # session 状态持久化 (localStorage/memory)
│   │       ├── discovery/
│   │       │   └── serverDiscovery.ts  # 读 server.json / 环境变量发现 localhost 端口
│   │       └── hooks/
│   │           └── useSession.ts       # React hook (可选, 供 web 复用)
│   │
│   ├── web/                        # @arclight/web
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── next.config.ts
│   │   ├── tailwind.config.ts
│   │   ├── postcss.config.mjs
│   │   └── src/
│   │       ├── app/
│   │       │   ├── layout.tsx
│   │       │   ├── page.tsx            # 重定向到 /chat
│   │       │   ├── chat/
│   │       │   │   ├── page.tsx        # 会话列表入口
│   │       │   │   └── [sessionId]/
│   │       │   │       └── page.tsx
│   │       │   └── api/
│   │       │       └── proxy/
│   │       │           └── [...path]/
│   │       │               └── route.ts  # MVP 单机: 透传到 localhost Hono
│   │       │
│   │       ├── components/
│   │       │   ├── chat/
│   │       │   │   ├── ArcThread.tsx       # @assistant-ui/react Thread 包装
│   │       │   │   ├── ArcTransport.ts     # ArcEvent → assistant-ui ExternalStore 桥接
│   │       │   │   ├── MessageParts.tsx    # 流式 part 级渲染
│   │       │   │   └── StreamingText.tsx
│   │       │   ├── tools/
│   │       │   │   ├── BashOutput.tsx      # PTY 输出渲染
│   │       │   │   ├── FileDiff.tsx        # diff 展示 (后期接 Monaco)
│   │       │   │   └── ToolCallCard.tsx    # 工具调用状态卡片
│   │       │   ├── approval/
│   │       │   │   ├── ApprovalModal.tsx   # 权限审批模态 (双向 SSE 往返)
│   │       │   │   └── RiskBadge.tsx
│   │       │   ├── session/
│   │       │   │   ├── SessionList.tsx
│   │       │   │   └── SessionHeader.tsx
│   │       │   └── layout/
│   │       │       ├── Sidebar.tsx
│   │       │       └── TopBar.tsx
│   │       │
│   │       ├── lib/
│   │       │   ├── arcClient.ts        # httpClient + sseTransport 实例 (从 client-core)
│   │       │   └── assistantRuntime.ts # AISDKRuntime / ExternalStoreRuntime 装配
│   │       │
│   │       └── styles/
│   │           └── globals.css
│   │
│   └── cli/                        # @arclight/cli  (P2 占位)
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── index.ts            # commander 骨架占位 + bun --compile 入口
│
└── .arclight/                      # 运行时目录 (gitignore, 按 repo 生成)
    ├── arclight.sqlite
    ├── server.json                 # {version,pid,port,origin,token,workspaceId,repoPath,createdAt}
    ├── audit/
    │   └── sandbox-<run_id>.jsonl
    ├── artifacts/
    │   ├── stdout/
    │   ├── diff/
    │   └── snapshot/
    ├── sandbox/
    │   ├── profiles/
    │   │   └── p0-local.json
    │   └── tmp/
    ├── cache/
    │   └── repomap/
    ├── memory/
    │   └── MEMORY.md
    └── skills/
        └── (用户安装的 SKILL.md)
```

---

## 3. 根 `package.json`

```jsonc
{
  "name": "arclightagent",
  "private": true,
  "version": "0.1.0",
  "workspaces": [
    "packages/protocol",
    "packages/core",
    "packages/client-core",
    "packages/web",
    "packages/cli"
  ],
  "scripts": {
    "dev":        "bun run --filter @arclight/core dev & bun run --filter @arclight/web dev",
    "dev:core":   "bun run --filter @arclight/core dev",
    "dev:web":    "bun run --filter @arclight/web dev",
    "build":      "bun run --filter '*' build",
    "test":       "vitest run",
    "test:watch": "vitest",
    "lint":       "biome lint .",
    "format":     "biome format --write .",
    "check":      "biome check --write .",
    "typecheck":  "bun run --filter '*' typecheck",
    "db:generate":"bun run --filter @arclight/core db:generate",
    "db:migrate": "bun run --filter @arclight/core db:migrate"
  },
  "devDependencies": {
    "@biomejs/biome": "^1",
    "typescript":     "^5",
    "vitest":         "^2"
  }
}
```

---

## 4. 各包 `package.json`

### 4.1 `packages/protocol/package.json`

```jsonc
{
  "name": "@arclight/protocol",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main":   "./dist/index.js",
  "types":  "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types":  "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build":     "bun build ./src/index.ts --outdir dist --target bun --format esm --declaration",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^4"
  },
  "devDependencies": {
    "typescript": "^5"
  }
}
```

### 4.2 `packages/core/package.json`

```jsonc
{
  "name": "@arclight/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main":  "./src/index.ts",
  "scripts": {
    "dev":        "bun --hot run src/serve.ts",
    "build":      "bun build ./src/serve.ts --outdir dist --target bun --format esm",
    "typecheck":  "tsc --noEmit",
    "db:generate":"drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "test":       "vitest run"
  },
  "dependencies": {
    "@arclight/protocol":        "workspace:*",
    "ai":                        "~6",
    "@ai-sdk/anthropic":         "^1",
    "zod":                       "^4",
    "@modelcontextprotocol/sdk": "^1",
    "gray-matter":               "^4",
    "hono":                      "^4",
    "drizzle-orm":               "^0.40",
    "web-tree-sitter":           "^0.25",
    "tree-sitter-typescript":    "^0.23",
    "graphology":                "^0.26",
    "graphology-pagerank":       "^0.1",
    "diff-match-patch":          "^1",
    "diff":                      "^7",
    "simple-git":                "^3",
    "node-pty":                  "^1",
    "shell-quote":               "^1",
    "pino":                      "^9"
  },
  "devDependencies": {
    "drizzle-kit":  "^0.30",
    "typescript":   "^5",
    "vitest":       "^2",
    "@types/diff":  "^7",
    "@types/shell-quote": "^1"
  }
}
```

### 4.3 `packages/client-core/package.json`

```jsonc
{
  "name": "@arclight/client-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main":  "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types":  "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build":     "bun build ./src/index.ts --outdir dist --target browser --format esm",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@arclight/protocol": "workspace:*",
    "zod":                "^4"
  },
  "devDependencies": {
    "typescript": "^5",
    "@types/react": "^19"
  },
  "peerDependencies": {
    "react": "^19"
  },
  "peerDependenciesMeta": {
    "react": { "optional": true }
  }
}
```

### 4.4 `packages/web/package.json`

```jsonc
{
  "name": "@arclight/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev":       "next dev --port 3000",
    "build":     "next build",
    "start":     "next start",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@arclight/protocol":          "workspace:*",
    "@arclight/client-core":       "workspace:*",
    "next":                        "^15",
    "react":                       "^19",
    "react-dom":                   "^19",
    "@assistant-ui/react":         "^0",
    "@assistant-ui/react-ai-sdk":  "^0",
    "ai":                          "~6",
    "tailwindcss":                 "^4",
    "zod":                         "^4"
  },
  "devDependencies": {
    "typescript":                  "^5",
    "@types/react":                "^19",
    "@types/react-dom":            "^19",
    "@types/node":                 "^22"
  }
}
```

### 4.5 `packages/cli/package.json`（P2 占位）

```jsonc
{
  "name": "@arclight/cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "arclight": "./dist/index.js"
  },
  "scripts": {
    "dev":       "bun run src/index.ts",
    "build":     "bun build ./src/index.ts --outdir dist --target bun --compile",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@arclight/protocol":    "workspace:*",
    "@arclight/client-core": "workspace:*",
    "@arclight/core":        "workspace:*",
    "commander":             "^12",
    "@clack/prompts":        "^0.10"
  },
  "devDependencies": {
    "typescript": "^5"
  }
}
```

---

## 5. TypeScript 配置

### 5.1 根 `tsconfig.base.json`

```jsonc
{
  "compilerOptions": {
    "target":           "ES2022",
    "module":           "ESNext",
    "moduleResolution": "Bundler",
    "lib":              ["ES2022", "DOM"],
    "strict":           true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "declaration":     true,
    "declarationMap":  true,
    "sourceMap":       true,
    "esModuleInterop": false,
    "allowSyntheticDefaultImports": true,
    "skipLibCheck":    true
  }
}
```

### 5.2 `packages/protocol/tsconfig.json`

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir":  "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

### 5.3 `packages/core/tsconfig.json`

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir":  "./dist",
    "rootDir": "./src",
    "types":   ["bun-types"],
    "lib":     ["ES2022"]
  },
  "include": ["src"],
  "references": [
    { "path": "../protocol" }
  ]
}
```

### 5.4 `packages/client-core/tsconfig.json`

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir":  "./dist",
    "rootDir": "./src",
    "lib":     ["ES2022", "DOM"]
  },
  "include": ["src"],
  "references": [
    { "path": "../protocol" }
  ]
}
```

### 5.5 `packages/web/tsconfig.json`

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir":     "./dist",
    "rootDir":    "./src",
    "lib":        ["ES2022", "DOM"],
    "jsx":        "preserve",
    "incremental": true,
    "plugins":    [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src", "next.config.ts", ".next/types/**/*.ts"],
  "references": [
    { "path": "../protocol" },
    { "path": "../client-core" }
  ]
}
```

---

## 6. Biome 配置（`biome.json`）

```jsonc
{
  "$schema":  "https://biomejs.dev/schemas/1.9.0/schema.json",
  "vcs": {
    "enabled":        true,
    "clientKind":     "git",
    "useIgnoreFile":  true
  },
  "files": {
    "ignoreUnknown": true,
    "ignore": [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "packages/core/src/db/migrations/**"
    ]
  },
  "formatter": {
    "enabled":      true,
    "indentStyle":  "space",
    "indentWidth":  2,
    "lineWidth":    100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedVariables":   "error",
        "noUnusedImports":     "error"
      },
      "suspicious": {
        "noExplicitAny":       "warn",
        "noConsoleLog":        "warn"
      },
      "style": {
        "useConst":            "error",
        "noNonNullAssertion":  "warn"
      }
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle":     "double",
      "semicolons":     "always",
      "trailingCommas": "all"
    }
  },
  "overrides": [
    {
      "include": ["packages/web/**"],
      "linter": {
        "rules": {
          "suspicious": { "noConsoleLog": "off" }
        }
      }
    }
  ]
}
```

---

## 7. Vitest Workspace（`vitest.workspace.ts`）

```ts
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name:        "protocol",
      root:        "./packages/protocol",
      environment: "node",
    },
  },
  {
    test: {
      name:        "core",
      root:        "./packages/core",
      environment: "node",
      // golden eval 走完整 HTTP/SSE/tool/sandbox 链路
      testTimeout: 60_000,
      hookTimeout: 30_000,
    },
  },
  {
    test: {
      name:        "client-core",
      root:        "./packages/client-core",
      environment: "jsdom",
    },
  },
]);
```

---

## 8. 构建与打包约定

### 8.1 开发阶段（`bun --hot`）

```bash
# 开发时 core 用 bun --hot(无需编译),web 用 next dev
bun run dev:core   # bun --hot run packages/core/src/serve.ts
bun run dev:web    # next dev  (packages/web/)
```

`serve.ts` 启动后写 `~/.config/arclightagent/server.json`（P0 也可写 `.arclight/server.json`），Web Dev Server 读取发现端口。

### 8.2 生产构建

```bash
bun run build
# protocol:    bun build --outdir dist  (纯 ESM 类型包)
# core:        bun build --outdir dist --target bun  (Hono server bundle)
# client-core: bun build --outdir dist --target browser
# web:         next build
# cli:         bun build --compile (单二进制,P2)
```

### 8.3 `bun --compile` 单二进制（P2 CLI，后置）

```bash
bun build packages/cli/src/index.ts \
  --compile \
  --outfile dist/arclight \
  --target bun-linux-x64   # 或 bun-darwin-arm64
```

`arclight serve --repo <path>` 子命令在 CLI 包内调用 `@arclight/core` 的 `serve()` 函数，二进制内嵌 core bundle。MVP 阶段 Web 前端独立 `next build` 输出静态资产，由 Hono 的 `serveStatic` 托管（或同端口反代）。

### 8.4 静态资产托管约定（MVP 本地部署）

Hono `app.ts` 中添加：

```ts
import { serveStatic } from "hono/bun";

// next build 输出到 packages/web/.next/standalone + packages/web/.next/static
// MVP 本地开发: Web 单独 next dev, core 单独 bun --hot serve.ts, CORS 仅允 127.0.0.1
// 生产: 用 Hono serveStatic 托管 .next/static, 其余由 next standalone server 代理
app.use("/api/*", ...);
app.get("/*", serveStatic({ root: "../web/.next/static" }));
```

**MVP 本地优先本地两服务（推荐）**：core `127.0.0.1:43127`，web `127.0.0.1:3000`，CORS 限本地，`arclight serve` 环境变量注入 `ARCLIGHT_CORE_URL=http://127.0.0.1:43127`。

---

## 9. `.arclight/` 运行时目录约定

| 路径 | 作用 | gitignore |
|---|---|---|
| `.arclight/arclight.sqlite` | SQLite 数据库（12 张表） | ✓ |
| `.arclight/server.json` | 进程发现（pid/port/token/workspaceId），`chmod 0600` | ✓ |
| `.arclight/audit/<run_id>.jsonl` | nono Merkle 审计日志 | ✓ |
| `.arclight/artifacts/<kind>/<id>` | 超限落盘文件（stdout/diff/snapshot） | ✓ |
| `.arclight/sandbox/profiles/p0-local.json` | nono sandbox profile | ✗（可版本化） |
| `.arclight/sandbox/tmp/` | 沙箱临时目录 | ✓ |
| `.arclight/cache/repomap/` | RepoMap pagerank 缓存 | ✓ |
| `.arclight/memory/MEMORY.md` | 伪长期记忆（~30 行） | ✓（默认）/ 可选加入 |
| `.arclight/skills/` | 用户安装的 SKILL.md | ✗（用户数据） |

`~/.config/arclightagent/server.json`：全局进程发现文件（多 repo 时最后一个覆写）。

---

## 10. `.env` / 配置加载

### 10.1 `.env.example`

```bash
# ── Provider ──────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...

# ── Core server ───────────────────────────────────────────
ARCLIGHT_PORT=43127
ARCLIGHT_HOST=127.0.0.1

# ── Auth ──────────────────────────────────────────────────
# 首次启动自动生成写入 server.json; 显式设置用于 CI/测试
# ARCLIGHT_LOOPBACK_TOKEN=<generated>

# ── Sandbox ───────────────────────────────────────────────
ARCLIGHT_SANDBOX_BACKEND=local-nono   # local-nono | docker-fallback | remote-vercel | remote-e2b
# VERCEL_SANDBOX_API_KEY=             # remote-vercel opt-in
# E2B_API_KEY=                        # remote-e2b opt-in

# ── Web dev proxy ─────────────────────────────────────────
ARCLIGHT_CORE_URL=http://127.0.0.1:43127

# ── Logging ───────────────────────────────────────────────
LOG_LEVEL=info                        # pino level: trace|debug|info|warn|error
LOG_PRETTY=true                       # dev 美化输出
```

### 10.2 配置加载（`packages/core/src/config/load.ts`）

配置优先级：`process.env` > `.arclight/config.json`（repo 级）> `~/.config/arclightagent/config.json`（用户级）> 内置默认值。

```ts
import { z } from "zod";

const ConfigSchema = z.object({
  port:            z.coerce.number().default(43127),
  host:            z.string().default("127.0.0.1"),
  anthropicApiKey: z.string().min(1),               // 必须，无默认
  sandboxBackend:  z.enum(["local-nono","docker-fallback","remote-vercel","remote-e2b"])
                    .default("local-nono"),
  logLevel:        z.enum(["trace","debug","info","warn","error"]).default("info"),
  logPretty:       z.coerce.boolean().default(false),
  loopbackToken:   z.string().optional(),           // 启动时生成若未设
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(repoPath: string): Config {
  // 1. 读 ~/.config/arclightagent/config.json
  // 2. 读 <repoPath>/.arclight/config.json (覆盖)
  // 3. process.env 映射 (ARCLIGHT_PORT → port, ANTHROPIC_API_KEY → anthropicApiKey, ...)
  // 4. zod parse + 启动失败时打印缺失字段
}
```

**安全约束**：`ANTHROPIC_API_KEY`（及任何 OAuth token）**绝不**写入 `server.json`；`server.json` 仅含进程发现信息（`chmod 0600`，启动时校验 owner === process.uid）。

---

## 11. 关键代码片段

### 11.1 `packages/protocol/src/events.ts`（ArcEvent union 骨架）

```ts
import { z } from "zod";

// ── 基础 ──────────────────────────────────────────────────
export const ArcEventBase = z.object({
  sessionId: z.string(),
  seq:       z.number().int().positive(),
  epoch:     z.number().int().nonneg(),
  ts:        z.number().int(),           // Unix ms
});

// ── 各 event 类型 ─────────────────────────────────────────
export const SessionStartedEvent = ArcEventBase.extend({
  t: z.literal("session.started"),
  workspaceId: z.string(),
  repoPath:    z.string(),
});

export const TurnStartedEvent = ArcEventBase.extend({
  t:         z.literal("turn.started"),
  turnId:    z.string(),
  commandId: z.string(),
});

export const MessageDeltaEvent = ArcEventBase.extend({
  t:      z.literal("message.delta"),
  turnId: z.string(),
  delta:  z.string(),
  role:   z.enum(["assistant", "tool"]),
});

export const ToolRequestedEvent = ArcEventBase.extend({
  t:           z.literal("tool.requested"),
  turnId:      z.string(),
  callId:      z.string(),
  name:        z.string(),
  argsPreview: z.string(),
});

export const ToolProgressEvent = ArcEventBase.extend({
  t:      z.literal("tool.progress"),
  callId: z.string(),
  kind:   z.enum(["sandbox.start", "stdout", "stderr"]),
  chunk:  z.string(),
});

export const ToolOutputEvent = ArcEventBase.extend({
  t:             z.literal("tool.output"),
  callId:        z.string(),
  resultPreview: z.string(),
  spillRef:      z.string().optional(),  // artifact://<id>
});

export const PermissionAskEvent = ArcEventBase.extend({
  t:       z.literal("permission.ask"),
  turnId:  z.string(),
  callId:  z.string(),
  askId:   z.string(),
  risk:    z.enum(["low", "med", "high"]),
  cls:     z.enum(["read", "write", "irreversible", "funds"]),
  action:  z.string(),
  detail:  z.record(z.unknown()),
  expiresAt: z.number().int(),
});

export const ContextCompactedEvent = ArcEventBase.extend({
  t:       z.literal("context.compacted"),
  turnId:  z.string(),
  summary: z.string(),
});

export const TurnCompletedEvent = ArcEventBase.extend({
  t:       z.literal("turn.completed"),
  turnId:  z.string(),
  usage:   z.object({
    inputTokens:      z.number().int(),
    outputTokens:     z.number().int(),
    cacheReadTokens:  z.number().int(),
    cacheWriteTokens: z.number().int(),
    costUsdMicros:    z.number().int(),
  }),
});

export const SessionErrorEvent = ArcEventBase.extend({
  t:          z.literal("session.error"),
  code:       z.string(),
  userMessage: z.string(),
  retryable:  z.boolean(),
});

export const InterruptedEvent = ArcEventBase.extend({
  t:      z.literal("interrupted"),
  turnId: z.string(),
  reason: z.enum(["user", "abort"]),
});

// ── Union ─────────────────────────────────────────────────
export const ArcEventSchema = z.discriminatedUnion("t", [
  SessionStartedEvent,
  TurnStartedEvent,
  MessageDeltaEvent,
  ToolRequestedEvent,
  ToolProgressEvent,
  ToolOutputEvent,
  PermissionAskEvent,
  ContextCompactedEvent,
  TurnCompletedEvent,
  SessionErrorEvent,
  InterruptedEvent,
]);

export type ArcEvent = z.infer<typeof ArcEventSchema>;
```

### 11.2 `packages/core/src/db/appendEvent.ts`（seq 事务，来自 P0 施工图）

```ts
import { db } from "./client.js";
import { events, sessions } from "./schema.js";
import { eq, and } from "drizzle-orm";
import type { ArcEvent } from "@arclight/protocol";

export async function appendEvent(
  sessionId: string,
  epoch: number,
  event: Omit<ArcEvent, "seq" | "epoch" | "ts">,
): Promise<{ seq: number }> {
  return db.transaction((tx) => {
    const session = tx
      .select({ nextSeq: sessions.nextSeq, epoch: sessions.epoch })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();

    if (!session) throw new Error(`session ${sessionId} not found`);
    if (session.epoch !== epoch) {
      throw new StaleEpochError(sessionId, epoch, session.epoch);
    }

    const seq = session.nextSeq;
    const ts  = Date.now();

    tx.insert(events).values({
      id:        `ev_${sessionId}_${seq}`,
      tenantId:  "local",
      sessionId,
      seq,
      epoch,
      type:      (event as { t: string }).t,
      event:     { ...event, seq, epoch, ts } as ArcEvent,
    }).run();

    tx.update(sessions)
      .set({ nextSeq: seq + 1, lastEventSeq: seq, updatedAt: new Date(ts) })
      .where(and(eq(sessions.id, sessionId), eq(sessions.epoch, epoch)))
      .run();

    return { seq };
  });
}

export class StaleEpochError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly clientEpoch: number,
    public readonly serverEpoch: number,
  ) {
    super(`Stale epoch: session=${sessionId} client=${clientEpoch} server=${serverEpoch}`);
    this.name = "StaleEpochError";
  }
}
```

### 11.3 `packages/core/src/server/routes/events.ts`（SSE replay，C2）

```ts
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../../db/client.js";
import { events, sessions } from "../../db/schema.js";
import { eq, and, gt } from "drizzle-orm";

export const eventsRoute = new Hono();

eventsRoute.get("/:id/events", async (c) => {
  const sessionId = c.req.param("id");
  const afterSeq  = Number(c.req.query("afterSeq") ?? 0);
  const reqEpoch  = Number(c.req.query("epoch") ?? 0);

  const session = db
    .select({ epoch: sessions.epoch })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();

  if (!session) return c.json({ error: "session not found" }, 404);

  // epoch-jump 检测
  if (reqEpoch > 0 && session.epoch !== reqEpoch) {
    return c.json(
      { reason: "epoch-jump", serverEpoch: session.epoch, snapshotUrl: null },
      409,
    );
  }

  return streamSSE(c, async (stream) => {
    // 1. replay 历史 events
    const past = db
      .select()
      .from(events)
      .where(and(eq(events.sessionId, sessionId), gt(events.seq, afterSeq)))
      .orderBy(events.seq)
      .all();

    for (const ev of past) {
      await stream.writeSSE({
        id:    String(ev.seq),
        event: ev.type,
        data:  JSON.stringify(ev.event),
      });
    }

    // 2. 实时推送新 events（轮询 SQLite，P0 朴素版；阶段二升级为内存 EventEmitter）
    let lastSeq = past.at(-1)?.seq ?? afterSeq;
    const HEARTBEAT_MS = 15_000;
    const POLL_MS      = 200;

    while (!stream.closed) {
      const fresh = db
        .select()
        .from(events)
        .where(and(eq(events.sessionId, sessionId), gt(events.seq, lastSeq)))
        .orderBy(events.seq)
        .all();

      for (const ev of fresh) {
        await stream.writeSSE({ id: String(ev.seq), event: ev.type, data: JSON.stringify(ev.event) });
        lastSeq = ev.seq;
      }

      // heartbeat（不落库）
      await stream.writeSSE({ event: "heartbeat", data: "" });

      await Bun.sleep(POLL_MS);

      // 实际心跳间隔由调用层计时，此处简化
      void HEARTBEAT_MS; // 后续改为 setInterval 心跳
    }
  });
});
```

### 11.4 `packages/client-core/src/transport/sseTransport.ts`（SSE 重连骨架）

```ts
import type { ArcEvent } from "@arclight/protocol";

export interface SseTransportOptions {
  baseUrl:    string;
  sessionId:  string;
  getToken:   () => string;
  onEvent:    (event: ArcEvent) => void;
  onError?:   (err: Error) => void;
}

export class SseTransport {
  #opts:      SseTransportOptions;
  #afterSeq   = 0;
  #epoch      = 0;
  #ctrl:      AbortController | null = null;
  #retryMs    = 1_000;

  constructor(opts: SseTransportOptions) {
    this.#opts = opts;
  }

  connect(afterSeq = 0, epoch = 0) {
    this.#afterSeq = afterSeq;
    this.#epoch    = epoch;
    this.#poll();
  }

  disconnect() {
    this.#ctrl?.abort();
    this.#ctrl = null;
  }

  async #poll() {
    this.#ctrl = new AbortController();
    const { baseUrl, sessionId, getToken, onEvent, onError } = this.#opts;
    const url = `${baseUrl}/api/sessions/${sessionId}/events?afterSeq=${this.#afterSeq}&epoch=${this.#epoch}`;

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${getToken()}` },
        signal:  this.#ctrl.signal,
      });

      if (res.status === 409) {
        const body = await res.json() as { reason: string; serverEpoch: number };
        if (body.reason === "epoch-jump") {
          // 触发 resync：清空本地状态，以新 epoch 重连
          this.#epoch    = body.serverEpoch;
          this.#afterSeq = 0;
          this.#poll();
          return;
        }
      }

      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);

      const reader = res.body.getReader();
      const dec    = new TextDecoder();
      let buf      = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });

        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        // 简化 SSE 解析（实际需完整 SSE parser）
        for (const line of lines) {
          if (line.startsWith("data:")) {
            try {
              const ev = JSON.parse(line.slice(5).trim()) as ArcEvent;
              this.#afterSeq = ev.seq;
              onEvent(ev);
            } catch { /* skip malformed */ }
          }
        }
      }

      this.#retryMs = 1_000; // 成功后重置退避
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      onError?.(err as Error);
    }

    // 指数退避重连
    await new Promise(r => setTimeout(r, this.#retryMs));
    this.#retryMs = Math.min(this.#retryMs * 2, 30_000);
    this.#poll();
  }
}
```

---

## 12. `.gitignore` 关键条目

```gitignore
# 运行时目录
.arclight/arclight.sqlite
.arclight/server.json
.arclight/audit/
.arclight/artifacts/
.arclight/sandbox/tmp/
.arclight/cache/

# 环境变量（绝不提交 API key）
.env
.env.local
.env.*.local

# 构建产物
dist/
.next/
node_modules/

# bun
bun.lockb      # 如使用老版本 bun（v1.2+ 用 bun.lock）
```

---

## 13. 第一周落地检查清单（Smoke Test 优先级）

根据选型清单评审强制要求，**第一周必须通过以下 smoke test**，任一失败则按回退方案降级：

| 测试项 | 验证命令 | 失败回退 |
|---|---|---|
| **Bun + node-pty** | `bun -e "const {spawn}=require('node-pty');const t=spawn('echo',['ok']);t.onData(d=>console.log(d))"` | 降级为 `child_process.spawn` 裸跑（丢 PTY 特性） |
| **Bun + web-tree-sitter WASM** | 运行 `packages/core/src/coding/tagExtractor.ts` 解析 10 行 TS 文件 | 改用纯正则粗提取（降精度） |
| **nono 可用性** | `nono run --profile .arclight/sandbox/profiles/p0-local.json -- echo ok` | 降级 `docker-fallback` |
| **drizzle + bun:sqlite** | 运行 `packages/core/src/db/migrate.ts`，12 张表建表成功 | N/A（内置，必须成功） |
| **Hono SSE** | curl `http://127.0.0.1:43127/api/sessions/test/events`，接收到 heartbeat event | N/A |

---

## 14. 包引用关系总览

```
@arclight/protocol
    ↑ (import type only)
    ├─ @arclight/core          (bun + hono + drizzle + ai + node-pty + ...)
    ├─ @arclight/client-core   (browser/node, 无运行时 AI 依赖)
    └─ @arclight/web           (next.js, via client-core + protocol)
            ↑
        @arclight/cli           (P2 占位, bun --compile)
```

- `@arclight/web` **不直接 import `@arclight/core` 实现**（只通过 HTTP/SSE），单向依赖不产生循环。
- MVP 阶段 `import type { ArcEvent } from "@arclight/protocol"` 在 `web` 和 `core` 双向 import 类型，零 codegen，零运行时依赖注入。
- `@arclight/client-core` 中的 `useSession` React hook 是可选 peer dep，CLI 包不载入。

---

这份布局将所有 5 份文档的决策落实到了可直接 `mkdir` + `touch` 的文件清单，主要决策对齐如下：P0 施工图的 12 张表 schema 全部落入 `packages/core/src/db/schema.ts`；拓扑决策（`arclight serve --repo` = localhost 同托管 Hono + Web + nono + SQLite）体现在 `serve.ts` + `serverJson.ts` + `.arclight/` 约定；工具执行契约的 `ArcCommand` / `Tool<In,Out>` / `ToolErrorEnvelope` 全部住在 `@arclight/protocol`；nono sandbox profile 随代码版本化存于 `packages/core/src/sandbox/profiles/p0-local.json`；选型清单要求的"MVP 第一周 smoke test"以清单形式明确列出；自研量 6000–9000+ 行的两大主体（主循环 `queryLoop.ts` 和前端 `ArcTransport + 工具渲染 + 权限 UI`）在目录树中有明确归属，不再被折叠成薄接缝。
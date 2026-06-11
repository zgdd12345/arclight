import type { NextConfig } from "next";

// 最简配置。web 跑 Node runtime（非 Bun，吸收 DEV_PLAN §1.3 PL-3）。
// workspace 包以 TS 源码导出（client-core/protocol exports → ./src/index.ts），交给 Next 转译。
const nextConfig: NextConfig = {
  transpilePackages: ["@arclight/client-core", "@arclight/protocol"],
};

export default nextConfig;

import type { NextConfig } from "next";

// 最简配置。web 跑 Node runtime（非 Bun，吸收 DEV_PLAN §1.3 PL-3）。
// workspace 包以 TS 源码导出（client-core/protocol exports → ./src/index.ts），交给 Next 转译。
//
// CSP（DEV_PLAN §2.2 ③）：Monaco 经 blob: URL 拉起 web worker，需放行 worker-src
// 'self' blob:。dev 不强制，此 header 保 build/生产环境 Monaco 懒加载可用。
const nextConfig: NextConfig = {
  transpilePackages: ["@arclight/client-core", "@arclight/protocol"],
  // dev 悬浮指示器（nextjs-portal）的透明容器会拦截底部 composer 发送按钮的点击
  //（挪位置 position 无效，容器仍占位）——直接禁用；构建错误全屏 overlay 不受影响
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "worker-src 'self' blob:;",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

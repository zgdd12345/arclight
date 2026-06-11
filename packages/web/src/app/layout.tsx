import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "arc light",
  description: "本地优先的写代码 Agent —— CARBON ARC",
};

// 字体三件套（DESIGN.md）：Google Fonts 取 Hanken Grotesk / Fraunces，
// Fontsource CDN 取 Commit Mono。全部走 <link> 运行时加载，构建期无网络依赖。
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-theme="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;600;700&family=Fraunces:opsz,wght@9..144,600&display=swap"
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/@fontsource/commit-mono@5/400.css"
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/@fontsource/commit-mono@5/700.css"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

// CORS 来源白名单：localhost + RFC1918 私网放行，公网/畸形来源拒绝。
import { describe, expect, test } from "bun:test";
import { isAllowedOrigin } from "../app";

describe("isAllowedOrigin", () => {
  test.each([
    "http://localhost:3000",
    "http://127.0.0.1:43127",
    "http://10.88.88.8:3000",
    "http://192.168.1.20:3000",
    "http://172.16.0.5:8080",
    "http://172.31.255.255:3000",
    "https://10.0.0.1:443",
    "http://10.0.0.5", // 无端口（默认 80）：浏览器对 80/443 不带端口的 Origin
    "https://192.168.1.20", // 无端口（默认 443）
    "http://[::1]:3000", // IPv6 回环
    "http://[::1]", // IPv6 回环无端口
    "http://[fd00::1]:3000", // IPv6 ULA fd00::/8（ARCLIGHT_HOST=:: 绑定）
    "http://[fc00::1]:8080", // IPv6 ULA fc00::/8
  ])("放行私网/回环来源 %s", (o) => {
    expect(isAllowedOrigin(o)).toBe(true);
  });

  test.each([
    "http://example.com:3000", // 公网域名
    "http://8.8.8.8:3000", // 公网 IP
    "http://8.8.8.8", // 公网 IP 无端口
    "http://172.32.0.1:3000", // 172.16/12 之外
    "http://11.0.0.1:3000", // 10/8 之外
    "http://[2001:db8::1]:3000", // 公网 IPv6
    "http://[fe80::1]:3000", // IPv6 link-local（非 ULA，拒绝）
    "ftp://10.88.88.8:3000", // 非 http(s)
    "http://evil.com/10.88.88.8:3000", // 伪装路径
    "http://10.88.88.8:3000.evil.com:443", // 后缀伪装（畸形端口）
    "http://10.88.88.8.evil.com:3000", // 私网前缀的公网域名
  ])("拒绝非私网/畸形来源 %s", (o) => {
    expect(isAllowedOrigin(o)).toBe(false);
  });
});

import { z } from "zod";

// 端能力声明（FULL_PLATFORM_DESIGN §3）。内核侧裁剪是纪律：端谎报只会拿到处理不了的事件，
// 内核仍以 profile 为准做安全决策。最终工具集 = 端 profile ∩ agent profile。
export const CapabilityProfileSchema = z.object({
  v: z.literal(1),
  localSandbox: z.boolean(),
  screenshot: z.enum(["none", "static", "stream"]),
  background: z.enum(["none", "limited", "full"]),
  fileSystem: z.enum(["none", "workspace", "full"]),
  liveSession: z.boolean(),
});
export type CapabilityProfile = z.infer<typeof CapabilityProfileSchema>;

// P0 本地 Web 默认：localhost 同托管，本地沙箱可用
export const P0_LOCAL_WEB_PROFILE: CapabilityProfile = {
  v: 1,
  localSandbox: true,
  screenshot: "none",
  background: "limited",
  fileSystem: "workspace",
  liveSession: false,
};

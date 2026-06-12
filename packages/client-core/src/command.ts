import type { ArcAck, ArcCommand, SubmitInput } from "@arclight/protocol";
import type { HttpClient } from "./transport/httpClient";

// C1 命令客户端。commandId 由客户端生成（幂等键：同 commandId 重试安全）。
export class CommandClient {
  constructor(private readonly http: HttpClient) {}

  private newId(): string {
    // crypto.randomUUID 仅安全上下文（HTTPS/localhost）可用；局域网 http 页面
    // （如 http://10.x.x.x:3000）拿不到它 → 用 getRandomValues 手搓 UUIDv4 回退
    //（getRandomValues 不受安全上下文限制）。
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = ((b[6] as number) & 0x0f) | 0x40; // version 4
    b[8] = ((b[8] as number) & 0x3f) | 0x80; // variant 10
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  private async send(cmd: ArcCommand): Promise<ArcAck> {
    const { body } = await this.http.postJson<ArcAck>("/api/commands", cmd);
    return body;
  }

  submit(sessionId: string, input: SubmitInput, commandId = this.newId()): Promise<ArcAck> {
    return this.send({ k: "submit", v: 1, commandId, sessionId, input });
  }

  interrupt(turnId: string, reason: "user" | "abort" = "user"): Promise<ArcAck> {
    return this.send({ k: "interrupt", v: 1, commandId: this.newId(), turnId, reason });
  }

  approve(
    askId: string,
    decision: "allow" | "deny",
    scope: "once" | "session" = "once",
  ): Promise<ArcAck> {
    return this.send({ k: "approve", v: 1, commandId: this.newId(), askId, decision, scope });
  }
}

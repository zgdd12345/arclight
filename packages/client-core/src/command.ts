import type { ArcAck, ArcCommand, SubmitInput } from "@arclight/protocol";
import type { HttpClient } from "./transport/httpClient";

// C1 命令客户端。commandId 由客户端生成（幂等键：同 commandId 重试安全）。
export class CommandClient {
  constructor(private readonly http: HttpClient) {}

  private newId(): string {
    return crypto.randomUUID();
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

  approve(askId: string, decision: "allow" | "deny"): Promise<ArcAck> {
    return this.send({ k: "approve", v: 1, commandId: this.newId(), askId, decision });
  }
}

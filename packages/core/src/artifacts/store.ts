import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/client";
import { artifacts } from "../db/schema";

// 超限落盘（P0 §C 输出投影）：>32KB 落 artifacts，事件/模型只见 preview(16KB) + spillRef。
export const PREVIEW_BYTES = 16 * 1024;
export const SPILL_THRESHOLD_BYTES = 32 * 1024;

export type ArtifactKind =
  | "stdout"
  | "stderr"
  | "tool-output"
  | "diff"
  | "file"
  | "audit"
  | "snapshot";

export class ArtifactStore {
  constructor(
    private readonly db: Db,
    private readonly arclightDir: string,
  ) {}

  save(input: {
    sessionId: string;
    turnId?: string;
    toolCallId?: string;
    kind: ArtifactKind;
    content: string;
    mime?: string;
  }): { id: string; spillRef: string; preview: string; sizeBytes: number } {
    const id = randomUUID();
    const dir = join(this.arclightDir, "artifacts", input.kind);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, id);
    const bytes = Buffer.from(input.content, "utf8");
    writeFileSync(path, bytes);
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const preview = input.content.slice(0, PREVIEW_BYTES);
    this.db
      .insert(artifacts)
      .values({
        id,
        sessionId: input.sessionId,
        turnId: input.turnId ?? null,
        toolCallId: input.toolCallId ?? null,
        kind: input.kind,
        path,
        mime: input.mime ?? "text/plain",
        sizeBytes: bytes.byteLength,
        sha256,
        preview,
      })
      .run();
    return { id, spillRef: `artifact://${id}`, preview, sizeBytes: bytes.byteLength };
  }

  readContent(id: string): string {
    const row = this.db
      .select()
      .from(artifacts)
      .all()
      .find((a) => a.id === id);
    if (!row) throw new Error(`artifact not found: ${id}`);
    return readFileSync(row.path, "utf8");
  }
}

import { describe, expect, test } from "bun:test";
import { jsonSchemaToZod } from "../schema";
import { runSubagent } from "../subagent";
import type { JsonSchema } from "../types";
import { makeCtx, scriptedProvider } from "./fixtures";

const reviewSchema: JsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "revised"] },
    score: { type: "number" },
  },
  required: ["verdict", "score"],
};

describe("jsonSchemaToZod", () => {
  test("accepts valid object, rejects missing required + bad enum", () => {
    const zod = jsonSchemaToZod(reviewSchema);
    expect(zod.safeParse({ verdict: "pass", score: 9 }).success).toBe(true);
    expect(zod.safeParse({ verdict: "nope", score: 9 }).success).toBe(false);
    expect(zod.safeParse({ verdict: "pass" }).success).toBe(false);
  });
});

describe("runSubagent structured return", () => {
  test("returns validated data as value when the model calls StructuredOutput", async () => {
    const { provider } = scriptedProvider([
      {
        result: {
          text: "",
          toolCalls: [
            { callId: "c1", name: "StructuredOutput", rawArgs: { verdict: "pass", score: 9 } },
          ],
          finishReason: "tool-calls",
        },
      },
      { result: { text: "done", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runSubagent(
      { prompt: "review", schema: reviewSchema },
      makeCtx({ provider }),
    );
    expect(res).toEqual({ ok: true, value: { verdict: "pass", score: 9 } });
  });

  test("schema mismatch yields a retryable VALIDATION envelope; model retries then succeeds", async () => {
    const { provider } = scriptedProvider([
      {
        result: {
          text: "",
          toolCalls: [{ callId: "c1", name: "StructuredOutput", rawArgs: { verdict: "maybe" } }],
          finishReason: "tool-calls",
        },
      },
      {
        result: {
          text: "",
          toolCalls: [
            { callId: "c2", name: "StructuredOutput", rawArgs: { verdict: "revised", score: 4 } },
          ],
          finishReason: "tool-calls",
        },
      },
      { result: { text: "done", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runSubagent(
      { prompt: "review", schema: reviewSchema },
      makeCtx({ provider }),
    );
    expect(res).toEqual({ ok: true, value: { verdict: "revised", score: 4 } });
  });

  test("finishing without calling StructuredOutput is a failure", async () => {
    const { provider } = scriptedProvider([
      { result: { text: "I refuse", toolCalls: [], finishReason: "stop" } },
    ]);
    const res = await runSubagent(
      { prompt: "review", schema: reviewSchema },
      makeCtx({ provider }),
    );
    expect(res.ok).toBe(false);
  });
});

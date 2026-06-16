import { describe, expect, test } from "bun:test";
import {
  type AgentSpec,
  assertSerializableSpec,
  type Budget,
  JsonSchemaZ,
  type RunStatus,
  type StageSpec,
  type SubagentResult,
  validateAgentSpec,
  validateStageSpec,
  WORKFLOW_EVENTS,
  WorkflowApiError,
} from "../types";

describe("M0 共享类型契约：守卫", () => {
  test("validateAgentSpec 接受合法规格并保留字段", () => {
    const spec = validateAgentSpec({ prompt: "do it", label: "x" }, "test");
    expect(spec.prompt).toBe("do it");
  });

  test("validateAgentSpec 拒绝空/缺失 prompt", () => {
    expect(() => validateAgentSpec({ prompt: "" }, "test")).toThrow(WorkflowApiError);
    expect(() => validateAgentSpec({}, "test")).toThrow(WorkflowApiError);
  });

  test("§2.1 守卫：闭包字段被拒（不可序列化）", () => {
    expect(() => validateAgentSpec({ prompt: "p", onDone: () => {} }, "test")).toThrow(
      WorkflowApiError,
    );
    expect(() => assertSerializableSpec({ cb: () => {} }, "test")).toThrow(WorkflowApiError);
  });

  test("validateAgentSpec 拒绝非对象", () => {
    expect(() => validateAgentSpec("nope", "test")).toThrow(WorkflowApiError);
    expect(() => validateAgentSpec(null, "test")).toThrow(WorkflowApiError);
  });

  test("validateStageSpec 复用 prompt 必填 + 闭包守卫", () => {
    expect(validateStageSpec({ prompt: "s" }, "stage").prompt).toBe("s");
    expect(() => validateStageSpec({ prompt: "" }, "stage")).toThrow(WorkflowApiError);
  });
});

describe("M0 共享类型契约：JsonSchema 结构化 + zod", () => {
  test("JsonSchemaZ 接受结构化 schema、拒绝坏 type", () => {
    const ok = JsonSchemaZ.safeParse({
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["pass", "fail"] },
        score: { type: "number" },
      },
      required: ["verdict"],
    });
    expect(ok.success).toBe(true);
    expect(JsonSchemaZ.safeParse({ type: "weird" }).success).toBe(false);
  });
});

describe("M0 共享类型契约：WorkflowEvent 名称常量（spec §8）", () => {
  test("六个事件名固定不漂移", () => {
    expect(WORKFLOW_EVENTS).toEqual({
      started: "workflow.started",
      phase: "workflow.phase",
      agentStarted: "workflow.agent.started",
      agentCompleted: "workflow.agent.completed",
      completed: "workflow.completed",
      failed: "workflow.failed",
    });
  });
});

describe("M0 共享类型契约：类型层（编译期）钉死形态", () => {
  test("SubagentResult / Budget / RunStatus / AgentSpec / StageSpec 形态自洽", () => {
    const ok: SubagentResult = { ok: true, value: "text" };
    const okObj: SubagentResult = { ok: true, value: { a: 1 } };
    const fail: SubagentResult = { ok: false, status: "interrupted" };
    const budget: Budget = { total: 100, spent: () => 10, remaining: () => 90 };
    const status: RunStatus = "interrupted";
    const a: AgentSpec = { prompt: "p", schema: { type: "string" }, isolation: "worktree" };
    const s: StageSpec = { prompt: "p", model: "glm-4.6" };
    expect(ok.ok && okObj.ok && !fail.ok).toBe(true);
    expect(budget.total).toBe(100);
    expect(status).toBe("interrupted");
    expect(a.prompt + s.prompt).toBe("pp");
  });
});

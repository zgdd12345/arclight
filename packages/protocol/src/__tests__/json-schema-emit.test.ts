import { describe, expect, test } from "bun:test";
import { emitProtocolJsonSchema } from "../../scripts/emit-json-schema";

describe("emitProtocolJsonSchema", () => {
  test("bundle includes ArcCommand and key event defs under $defs", () => {
    const bundle = emitProtocolJsonSchema() as {
      $defs: Record<string, unknown>;
    };
    expect(bundle.$defs).toBeDefined();
    expect(bundle.$defs.ArcCommand).toBeDefined();
    expect(bundle.$defs.ArcAck).toBeDefined();
    expect(bundle.$defs.CapabilityProfile).toBeDefined();
    // a representative event
    expect(bundle.$defs.TurnCompleted).toBeDefined();
  });
});

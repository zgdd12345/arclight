import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ArcCommandSchema } from "../commands";
import { TurnCompletedSchema } from "../events";

const dir = join(import.meta.dir, "..", "..", "fixtures");
const load = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));

describe("fixtures validate against zod", () => {
  test("arc-command-submit", () => {
    expect(() => ArcCommandSchema.parse(load("arc-command-submit.json"))).not.toThrow();
  });
  test("turn-completed", () => {
    expect(() => TurnCompletedSchema.parse(load("turn-completed.json"))).not.toThrow();
  });
});

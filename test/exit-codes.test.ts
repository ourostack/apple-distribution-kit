import { describe, expect, it } from "vitest";
import { defineExitCodes } from "../lib/ouro-ui/registry/ouro/ax/exit-codes.ts";
import { EXIT, EXIT_CODE_TABLE } from "../src/exit-codes.ts";

describe("exit codes", () => {
  it("are Ouro AX's base table, then this tool's own, built by the kit's defineExitCodes", () => {
    const table = defineExitCodes(EXIT_CODE_TABLE);
    expect(table.codes.map(({ code, name }) => ({ code, name }))).toEqual(EXIT_CODE_TABLE.map(({ code, name }) => ({ code, name })));
    expect(table.code("usage")).toBe(EXIT.usage);
    expect(table.code("invalid")).toBe(EXIT.invalid);
    expect(table.code("no-input")).toBe(EXIT.noInput);
    expect(table.code("unavailable")).toBe(EXIT.unavailable);
  });
});

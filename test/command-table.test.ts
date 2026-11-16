import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commands } from "../src/command-table.ts";
import { createCli } from "../src/cli-core.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("the command table", () => {
  it("is the set of commands help lists, so the X-ray's inventory matches the CLI", async () => {
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });
    await expect(cli(["--help", "--json"])).resolves.toBe(0);
    const listed = (JSON.parse(stdout.join("")) as { commands: { name: string }[] }).commands.map((command) => command.name);
    expect(listed).toEqual(commands.map((command) => command.name));
  });

  it("names every command the generated actions run", () => {
    const actions = JSON.parse(readFileSync(join(root, "actions/generated/actions.json"), "utf8")) as { actions: { cli: string }[] };
    const names = new Set(commands.map((command) => command.name));
    for (const action of actions.actions) expect(names.has(action.cli)).toBe(true);
  });

  it("answers help for an unknown topic on stderr, with the exit code of usage", async () => {
    const stderr: string[] = [];
    const cli = createCli({ stdout: () => undefined, stderr: (chunk) => stderr.push(chunk) });
    await expect(cli(["help", "no-such-command"])).resolves.toBe(2);
    expect(stderr.join("")).toMatch(/no help for "no-such-command"/);
  });
});

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

  it("refuses a wrong team id on a developer command other people see, before anything runs, and says where to get one", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: (chunk) => stderr.push(chunk) });
    const argv = ["developer", "keys", "apply", "--team-id", "axxraynoref", "--environment", "test", "--session-file", "s.json", "--plan-file", "p.json", "--why", "Riley asked"];
    await expect(cli(argv)).resolves.toBe(2);
    expect(stderr.join("")).toMatch(/--team-id "axxraynoref" is not a 10-character team id. Fix: take the right value from/);
    await expect(cli([...argv, "--json"])).resolves.toBe(2);
    expect(JSON.parse(stdout.join("")).error.code).toBe("bad-reference");
  });

  it("previews a command other people see with --dry-run, and sends nothing", async () => {
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });
    await expect(cli(["testflight", "publish", "--channel", "c", "--app-id", "a", "--build-id", "b", "--dry-run", "--why", "Riley asked"])).resolves.toBe(0);
    expect(stdout.join("")).toMatch(/Would send the TestFlight requests.*would see it\. Nothing is sent in a preview\./);
  });
});

import { describe, expect, it } from "vitest";
import { createCli } from "../src/cli-core.js";
import { developerCommand } from "../src/developer-cli.js";
import { signingCommand } from "../src/signing-cli.js";

const missingConfig = "/nonexistent-adk-config-for-test.json";

describe("direct callers of the command families", () => {
  it("refuses services plan without --config, the check the kit makes first", async () => {
    const stdout: string[] = [];
    const code = await developerCommand(
      { stdout: (chunk) => stdout.push(chunk), stderr: () => undefined },
      ["developer", "services", "plan", "--team-id", "TEAM123456", "--environment", "test", "--session-file", "s.json", "--plan-file", "p.json", "--json"]
    );
    expect(code).toBe(2);
    expect(stdout.join("")).toContain("invalid_arguments");
  });

  it("refuses a repeated flag to the developer parser itself", async () => {
    const stdout: string[] = [];
    const code = await developerCommand(
      { stdout: (chunk) => stdout.push(chunk), stderr: () => undefined },
      ["developer", "status", "--team-id", "TEAM123456", "--team-id", "TEAM123456", "--session-file", "s.json", "--json"]
    );
    expect(code).toBe(2);
    expect(stdout.join("")).toContain("invalid_arguments");
  });

  it("answers an unknown signing subcommand with usage", async () => {
    const stderr: string[] = [];
    const code = await signingCommand(
      { stdout: () => undefined, stderr: (chunk) => stderr.push(chunk) },
      false,
      ["signing", "nope"],
      {} as never
    );
    expect(code).toBe(2);
    expect(stderr.join("")).toMatch(/Unknown signing command: nope/);
  });

  it("uses the App Store Connect and App Review defaults when none are injected", async () => {
    const stderr: string[] = [];
    const cli = createCli({ stdout: () => undefined, stderr: (chunk) => stderr.push(chunk) });
    expect(await cli(["asc", "get", "--path", "/v1/apps", "--config", missingConfig])).toBe(5);
    expect(await cli(["review", "status", "--bundle-id", "app.example", "--config", missingConfig])).toBe(5);
    expect(stderr.length).toBeGreaterThan(0);
  });
});

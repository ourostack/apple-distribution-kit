import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCli, discoverConfigPath, loadConfig, resolveManifestPath } from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "adk-scaffold-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CLI scaffold", () => {
  it("prints help without touching Apple credentials", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const cli = createCli({
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk)
    });

    await expect(cli(["--help"])).resolves.toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("")).toContain("apple-distribution-kit");
    expect(stdout.join("")).toContain("manifest");
    expect(stdout.join("")).toContain("asc smoke");
  });

  it("prints help for empty arguments", async () => {
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(cli([])).resolves.toBe(0);
    expect(stdout.join("")).toContain("Usage:");
  });

  it("prints package version", async () => {
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(cli(["--version"])).resolves.toBe(0);
    expect(stdout.join("").trim()).toMatch(/^0\.1\.0$/);
  });

  it("returns structured JSON for unknown commands", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: (chunk) => stderr.push(chunk) });

    await expect(cli(["--json", "nope"])).resolves.toBe(64);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toEqual({
      ok: false,
      error: {
        code: "unknown_command",
        message: "Unknown command: nope"
      }
    });
  });

  it("returns text errors for unknown commands", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: (chunk) => stderr.push(chunk) });

    await expect(cli(["nope"])).resolves.toBe(64);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toBe("Unknown command: nope\n");
  });

  it("returns structured errors for missing manifest validation input", async () => {
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(cli(["--json", "manifest", "validate"])).resolves.toBe(65);
    expect(JSON.parse(stdout.join("")).ok).toBe(false);
    expect(JSON.parse(stdout.join("")).error.code).toBe("manifest_invalid");
  });

  it("validates explicit manifest paths as JSON", async () => {
    const dir = await makeTempDir();
    const manifestPath = join(dir, "apple-distribution.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        app: { name: "Example", bundleId: "bot.example" },
        team: { teamId: "TEAMID" },
        channels: [
          {
            id: "direct",
            platform: "macos",
            distribution: "developer-id",
            bundleId: "bot.example",
            buildCommand: "build",
            packageCommand: "package"
          }
        ]
      })
    );
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(cli(["--json", "manifest", "validate", "--manifest", manifestPath])).resolves.toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({ ok: true, manifestPath });
  });

  it("validates default manifest paths as text", async () => {
    const dir = await makeTempDir();
    const manifestDir = join(dir, "distribution");
    await import("node:fs/promises").then(async ({ mkdir }) => mkdir(manifestDir));
    await writeFile(
      join(manifestDir, "apple-distribution.json"),
      JSON.stringify({
        schemaVersion: 1,
        app: { name: "Example", bundleId: "bot.example" },
        team: { teamId: "TEAMID" },
        channels: [
          {
            id: "direct",
            platform: "macos",
            distribution: "developer-id",
            bundleId: "bot.example",
            buildCommand: "build",
            packageCommand: "package"
          }
        ]
      })
    );
    const originalCwd = process.cwd();
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    try {
      process.chdir(dir);
      await expect(cli(["manifest", "validate"])).resolves.toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
    expect(stdout.join("")).toBe("Manifest valid: distribution/apple-distribution.json\n");
  });

  it("returns text not-implemented errors for asc smoke", async () => {
    const stderr: string[] = [];
    const cli = createCli({ stdout: () => undefined, stderr: (chunk) => stderr.push(chunk) });

    await expect(cli(["asc", "smoke"])).resolves.toBe(70);
    expect(stderr.join("")).toBe("asc smoke is not implemented yet\n");
  });
});

describe("config discovery", () => {
  it("uses an explicit config path before environment or defaults", () => {
    expect(discoverConfigPath({ explicitConfigPath: "/tmp/adk.json", env: {} })).toBe("/tmp/adk.json");
  });

  it("uses APPLE_DISTRIBUTION_KIT_CONFIG from the environment", () => {
    expect(discoverConfigPath({ env: { APPLE_DISTRIBUTION_KIT_CONFIG: "/tmp/from-env.json" } })).toBe(
      "/tmp/from-env.json"
    );
  });

  it("falls back to the standard Application Support path", () => {
    expect(discoverConfigPath({ env: {}, homeDir: "/Users/example" })).toBe(
      "/Users/example/Library/Application Support/AppleDistributionKit/app-store-connect/config.json"
    );
  });

  it("uses the current home directory when no home override is provided", () => {
    expect(discoverConfigPath({ env: {} })).toBe(
      join(homedir(), "Library", "Application Support", "AppleDistributionKit", "app-store-connect", "config.json")
    );
  });

  it("loads and validates config without returning private key contents", async () => {
    const dir = await makeTempDir();
    const privateKeyPath = join(dir, "AuthKey_TEST.p8");
    const configPath = join(dir, "config.json");
    await writeFile(privateKeyPath, "PRIVATE KEY CONTENTS");
    await writeFile(
      configPath,
      JSON.stringify({
        issuerId: "b25f0f77-25c0-44b8-9d21-2e95083f09ae",
        keyId: "8566429KZF",
        privateKeyPath
      })
    );

    await expect(loadConfig(configPath)).resolves.toEqual({
      issuerId: "b25f0f77-25c0-44b8-9d21-2e95083f09ae",
      keyId: "8566429KZF",
      privateKeyPath
    });
  });

  it("rejects non-object config", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "config.json");
    await writeFile(configPath, "null");

    await expect(loadConfig(configPath)).rejects.toThrow("Invalid App Store Connect config");
  });

  it.each([
    [{ issuerId: "", keyId: "KEY", privateKeyPath: "/tmp/key.p8" }],
    [{ issuerId: "issuer", keyId: "", privateKeyPath: "/tmp/key.p8" }],
    [{ issuerId: "issuer", keyId: "KEY", privateKeyPath: "" }],
    [{ issuerId: 7, keyId: "KEY", privateKeyPath: "/tmp/key.p8" }],
    [{ issuerId: "issuer", keyId: 7, privateKeyPath: "/tmp/key.p8" }],
    [{ issuerId: "issuer", keyId: "KEY", privateKeyPath: 7 }]
  ])("rejects malformed config %#", async (config) => {
    const dir = await makeTempDir();
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(config));

    await expect(loadConfig(configPath)).rejects.toThrow("Invalid App Store Connect config");
  });
});

describe("manifest path resolution", () => {
  it("returns an explicit manifest path unchanged", () => {
    expect(resolveManifestPath({ explicitManifestPath: "/tmp/manifest.json", cwd: "/repo" })).toBe("/tmp/manifest.json");
  });

  it("defaults to distribution/apple-distribution.json inside the current repo", () => {
    expect(resolveManifestPath({ cwd: "/repo" })).toBe("/repo/distribution/apple-distribution.json");
  });
});

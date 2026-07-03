import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(stdout.join("")).toContain("plan");
    expect(stdout.join("")).toContain("store review-plan");
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

  it("prints a dry-run distribution plan as JSON", async () => {
    const dir = await makeTempDir();
    const manifestPath = join(dir, "apple-distribution.json");
    await writeFile(manifestPath, JSON.stringify(minimalManifest()));
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(cli(["--json", "plan", "--manifest", manifestPath])).resolves.toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({
      ok: true,
      mode: "dry-run",
      app: {
        name: "Example",
        bundleId: "bot.example"
      },
      actions: [
        {
          type: "validate-channel",
          channelId: "direct",
          distribution: "developer-id"
        }
      ],
      requiresHuman: []
    });
  });

  it("prints an apply distribution plan as text", async () => {
    const dir = await makeTempDir();
    const manifestPath = join(dir, "apple-distribution.json");
    await writeFile(manifestPath, JSON.stringify(minimalManifest()));
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(cli(["plan", "--mode", "apply", "--manifest", manifestPath])).resolves.toBe(0);
    expect(stdout.join("")).toBe("Distribution plan: Example (1 action, mode apply)\n");
  });

  it("rejects unknown distribution plan modes", async () => {
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(cli(["--json", "plan", "--mode", "publish"])).resolves.toBe(64);
    expect(JSON.parse(stdout.join(""))).toEqual({
      ok: false,
      error: {
        code: "invalid_mode",
        message: "Unknown plan mode: publish"
      }
    });
  });

  it("prints store review-prep blockers and writes an artifact", async () => {
    const dir = await makeTempDir();
    const manifestPath = join(dir, "apple-distribution.json");
    const artifactPath = join(dir, "app-store-review-prep.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...minimalManifest(),
        channels: [
          {
            id: "mac-app-store",
            platform: "macos",
            distribution: "app-store",
            bundleId: "bot.example",
            buildCommand: "build",
            packageCommand: "package",
            store: {
              version: "1.0",
              copyright: "Copyright 2026",
              category: "PRODUCTIVITY",
              screenshots: [],
              privacy: { policyUrl: "https://example.com/privacy", collectsData: false },
              exportCompliance: { usesEncryption: true, exempt: true }
            }
          }
        ]
      })
    );
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(
      cli([
        "--json",
        "store",
        "review-plan",
        "--manifest",
        manifestPath,
        "--channel",
        "mac-app-store",
        "--artifact",
        artifactPath
      ])
    ).resolves.toBe(0);
    const output = JSON.parse(stdout.join(""));
    expect(output.blockers).toContainEqual({
      code: "screenshots-assets-required",
      message: "Screenshots/app previews must exist locally or be proven present remotely before review submission.",
      evidence: { channelId: "mac-app-store" }
    });
    await expect(readFile(artifactPath, "utf8").then(JSON.parse)).resolves.toEqual(output);
  });

  it("returns text errors for missing store review channel", async () => {
    const dir = await makeTempDir();
    const manifestPath = join(dir, "apple-distribution.json");
    await writeFile(manifestPath, JSON.stringify(minimalManifest()));
    const stderr: string[] = [];
    const cli = createCli({ stdout: () => undefined, stderr: (chunk) => stderr.push(chunk) });

    await expect(cli(["store", "review-plan", "--manifest", manifestPath])).resolves.toBe(64);
    expect(stderr.join("")).toBe("store review-plan requires --channel <id>\n");
  });

  it("returns text errors for asc smoke with a missing explicit config", async () => {
    const stderr: string[] = [];
    const cli = createCli({ stdout: () => undefined, stderr: (chunk) => stderr.push(chunk) });

    await expect(cli(["asc", "smoke", "--config", "/tmp/does-not-exist-adk.json"])).resolves.toBe(69);
    expect(stderr.join("")).toContain("no such file or directory");
  });

  it("prints JSON for successful asc smoke through injected dependencies", async () => {
    const stdout: string[] = [];
    const cli = createCli(
      { stdout: (chunk) => stdout.push(chunk), stderr: () => undefined },
      { smokeAppStoreConnect: async ({ configPath }) => ({ configPath, data: [] }) }
    );

    await expect(cli(["--json", "asc", "smoke", "--config", "/tmp/config.json"])).resolves.toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({ ok: true, result: { configPath: "/tmp/config.json", data: [] } });
  });

  it("prints text for successful asc smoke through default config discovery", async () => {
    const stdout: string[] = [];
    const cli = createCli(
      { stdout: (chunk) => stdout.push(chunk), stderr: () => undefined },
      { smokeAppStoreConnect: async ({ configPath }) => ({ configPath }) }
    );

    await expect(cli(["asc", "smoke"])).resolves.toBe(0);
    expect(stdout.join("")).toBe("App Store Connect API smoke passed\n");
  });
});

function minimalManifest() {
  return {
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
  };
}

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

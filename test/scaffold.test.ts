import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
});

describe("manifest path resolution", () => {
  it("returns an explicit manifest path unchanged", () => {
    expect(resolveManifestPath({ explicitManifestPath: "/tmp/manifest.json", cwd: "/repo" })).toBe("/tmp/manifest.json");
  });

  it("defaults to distribution/apple-distribution.json inside the current repo", () => {
    expect(resolveManifestPath({ cwd: "/repo" })).toBe("/repo/distribution/apple-distribution.json");
  });
});

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
    expect(stdout.join("")).toContain("xcode run");
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
        },
        {
          type: "build-channel",
          channelId: "direct",
          distribution: "developer-id",
          command: "build"
        },
        {
          type: "package-channel",
          channelId: "direct",
          distribution: "developer-id",
          command: "package"
        },
        {
          type: "sign-notarize-direct-download",
          channelId: "direct",
          distribution: "developer-id"
        },
        {
          type: "publish-direct-download",
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
    expect(stdout.join("")).toBe("Distribution plan: Example (5 actions, mode apply)\n");
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

  it("returns structured errors for invalid distribution plans", async () => {
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(cli(["--json", "plan", "--manifest", "/tmp/does-not-exist-adk.json"])).resolves.toBe(65);
    expect(JSON.parse(stdout.join("")).error.code).toBe("plan_failed");
  });

  it("uses the default manifest path for plan and store review-plan commands", async () => {
    const dir = await makeTempDir();
    const manifestDir = join(dir, "distribution");
    await import("node:fs/promises").then(async ({ mkdir }) => {
      await mkdir(manifestDir);
      await mkdir(join(manifestDir, "store-assets", "mac"), { recursive: true });
    });
    await writeFile(join(manifestDir, "store-assets", "mac", "01-main.png"), "fake png");
    await writeFile(
      join(manifestDir, "apple-distribution.json"),
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
              screenshots: ["store-assets/mac/01-main.png"],
              privacy: { policyUrl: "https://example.com/privacy", collectsData: false },
              exportCompliance: { usesEncryption: true, exempt: true }
            }
          }
        ]
      })
    );
    const originalCwd = process.cwd();
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    try {
      process.chdir(dir);
      await expect(cli(["plan"])).resolves.toBe(0);
      await expect(cli(["store", "review-plan", "--channel", "mac-app-store"])).resolves.toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
    expect(stdout.join("")).toContain("Distribution plan: Example");
    expect(stdout.join("")).toContain("Store review plan: 3 actions, 2 blockers");
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

  it("prints store review-prep text without an artifact", async () => {
    const dir = await makeTempDir();
    const manifestPath = join(dir, "apple-distribution.json");
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
              screenshots: ["store-assets/mac/01-main.png"],
              privacy: { policyUrl: "https://example.com/privacy", collectsData: false },
              exportCompliance: { usesEncryption: true, exempt: true }
            }
          }
        ]
      })
    );
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(cli(["store", "review-plan", "--manifest", manifestPath, "--channel", "mac-app-store"])).resolves.toBe(0);
    expect(stdout.join("")).toBe("Store review plan: 0 actions, 1 blocker\n");
  });

  it("dry-runs xcode commands as JSON without invoking Apple tooling", async () => {
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(
      cli([
        "--json",
        "xcode",
        "run",
        "--kind",
        "codesign",
        "--mode",
        "dry-run",
        "--identity",
        "Apple Distribution: Ari",
        "--path",
        "OuroMD.app",
        "--entitlements",
        "config/app-store-entitlements.plist"
      ])
    ).resolves.toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({
      ok: true,
      mode: "dry-run",
      command: [
        "codesign",
        "--force",
        "--deep",
        "--options",
        "runtime",
        "--timestamp",
        "--entitlements",
        "config/app-store-entitlements.plist",
        "--sign",
        "Apple Distribution: Ari",
        "OuroMD.app"
      ]
    });
  });

  it("prints xcode dry-run commands as text", async () => {
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(cli(["xcode", "run", "--kind", "spctl", "--path", "OuroMD.app"])).resolves.toBe(0);
    expect(stdout.join("")).toBe("Would run: spctl --assess --type execute OuroMD.app\n");
  });

  it.each([
    ["stapler", "Would run: xcrun stapler staple OuroMD.app\n"],
    ["stapler-validate", "Would run: xcrun stapler validate OuroMD.app\n"]
  ])("prints %s dry-run commands as text", async (kind, output) => {
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(cli(["xcode", "run", "--kind", kind, "--path", "OuroMD.app"])).resolves.toBe(0);
    expect(stdout.join("")).toBe(output);
  });

  it("dry-runs notary submit commands", async () => {
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(
      cli([
        "--json",
        "xcode",
        "run",
        "--kind",
        "notary-submit",
        "--apple-id",
        "ari@example.com",
        "--team-id",
        "TEAM",
        "--password-keychain-item",
        "notary-profile",
        "--package-path",
        "OuroMD.zip"
      ])
    ).resolves.toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({
      ok: true,
      mode: "dry-run",
      command: [
        "xcrun",
        "notarytool",
        "submit",
        "OuroMD.zip",
        "--apple-id",
        "ari@example.com",
        "--team-id",
        "TEAM",
        "--keychain-profile",
        "notary-profile",
        "--wait"
      ]
    });
  });

  it("dry-runs productbuild commands", async () => {
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(
      cli([
        "--json",
        "xcode",
        "run",
        "--kind",
        "productbuild",
        "--identity",
        "3rd Party Mac Developer Installer: Ari",
        "--component",
        "OuroMD.app",
        "--install-location",
        "/Applications",
        "--output",
        "OuroMD.pkg"
      ])
    ).resolves.toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({
      ok: true,
      mode: "dry-run",
      command: [
        "productbuild",
        "--component",
        "OuroMD.app",
        "/Applications",
        "--sign",
        "3rd Party Mac Developer Installer: Ari",
        "OuroMD.pkg"
      ]
    });
  });

  it("runs xcode apply commands through the injected executor and returns non-zero failures", async () => {
    const stdout: string[] = [];
    const cli = createCli(
      { stdout: (chunk) => stdout.push(chunk), stderr: () => undefined },
      { executeXcodeCommand: async (argv) => ({ exitCode: 7, stdout: "", stderr: `failed ${argv.join(" ")}` }) }
    );

    await expect(
      cli([
        "--json",
        "xcode",
        "run",
        "--kind",
        "altool-validate",
        "--mode",
        "apply",
        "--package-path",
        "OuroMD.pkg",
        "--api-key",
        "KEY",
        "--api-issuer",
        "issuer",
        "--p8-file-path",
        "/tmp/AuthKey_KEY.p8",
        "--provider-public-id",
        "743GT2AJ24"
      ])
    ).resolves.toBe(7);
    const output = JSON.parse(stdout.join(""));
    expect(output).toMatchObject({
      ok: false,
      mode: "apply",
      exitCode: 7,
      command: [
        "xcrun",
        "altool",
        "--validate-app",
        "-f",
        "OuroMD.pkg",
        "--type",
        "macos",
        "--api-key",
        "KEY",
        "--api-issuer",
        "issuer",
        "--p8-file-path",
        "[REDACTED_SECRET]",
        "--provider-public-id",
        "743GT2AJ24",
        "--output-format",
        "json"
      ]
    });
    expect(output.stderr).toContain("--p8-file-path [REDACTED_SECRET]");
    expect(output.stderr).not.toContain("/tmp/AuthKey_KEY.p8");
  });

  it("runs xcode apply commands with username/password altool auth", async () => {
    const stdout: string[] = [];
    const cli = createCli(
      { stdout: (chunk) => stdout.push(chunk), stderr: () => undefined },
      { executeXcodeCommand: async (argv) => ({ exitCode: 0, stdout: `ran ${argv.join(" ")}`, stderr: "" }) }
    );

    await expect(
      cli([
        "--json",
        "xcode",
        "run",
        "--kind",
        "altool-upload",
        "--mode",
        "apply",
        "--package-path",
        "OuroMD.pkg",
        "--username",
        "ari@example.com",
        "--password",
        "app-password",
        "--provider-public-id",
        "743GT2AJ24"
      ])
    ).resolves.toBe(0);
    const output = JSON.parse(stdout.join(""));
    expect(output).toMatchObject({
      ok: true,
      mode: "apply",
      command: [
        "xcrun",
        "altool",
        "--upload-package",
        "OuroMD.pkg",
        "--type",
        "macos",
        "--username",
        "ari@example.com",
        "--password",
        "[REDACTED_SECRET]",
        "--provider-public-id",
        "743GT2AJ24",
        "--output-format",
        "json",
        "--wait"
      ]
    });
    expect(output.stdout).toContain("--password [REDACTED_SECRET]");
    expect(output.stdout).not.toContain("app-password");
  });

  it("dry-runs altool auth without optional provider or p8 arguments", async () => {
    const apiStdout: string[] = [];
    const apiCli = createCli({ stdout: (chunk) => apiStdout.push(chunk), stderr: () => undefined });
    await expect(
      apiCli([
        "--json",
        "xcode",
        "run",
        "--kind",
        "altool-validate",
        "--package-path",
        "OuroMD.pkg",
        "--api-key",
        "KEY",
        "--api-issuer",
        "issuer"
      ])
    ).resolves.toBe(0);
    expect(JSON.parse(apiStdout.join("")).command).toEqual([
      "xcrun",
      "altool",
      "--validate-app",
      "-f",
      "OuroMD.pkg",
      "--type",
      "macos",
      "--api-key",
      "KEY",
      "--api-issuer",
      "issuer",
      "--output-format",
      "json"
    ]);

    const usernameStdout: string[] = [];
    const usernameCli = createCli({ stdout: (chunk) => usernameStdout.push(chunk), stderr: () => undefined });
    await expect(
      usernameCli([
        "--json",
        "xcode",
        "run",
        "--kind",
        "altool-upload",
        "--package-path",
        "OuroMD.pkg",
        "--username",
        "ari@example.com",
        "--password",
        "app-password"
      ])
    ).resolves.toBe(0);
    expect(JSON.parse(usernameStdout.join("")).command).toEqual([
      "xcrun",
      "altool",
      "--upload-package",
      "OuroMD.pkg",
      "--type",
      "macos",
      "--username",
      "ari@example.com",
      "--password",
      "[REDACTED_SECRET]",
      "--output-format",
      "json",
      "--wait"
    ]);
  });

  it("redacts secrets in text dry-run output", async () => {
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(
      cli([
        "xcode",
        "run",
        "--kind",
        "altool-upload",
        "--package-path",
        "OuroMD.pkg",
        "--username",
        "ari@example.com",
        "--password",
        "app-password"
      ])
    ).resolves.toBe(0);
    expect(stdout.join("")).toContain("--password [REDACTED_SECRET]");
    expect(stdout.join("")).not.toContain("app-password");
  });

  it("prints xcode apply success and failure as text", async () => {
    const successStdout: string[] = [];
    const successCli = createCli(
      { stdout: (chunk) => successStdout.push(chunk), stderr: () => undefined },
      { executeXcodeCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }
    );

    await expect(successCli(["xcode", "run", "--kind", "spctl", "--mode", "apply", "--path", "OuroMD.app"])).resolves.toBe(0);
    expect(successStdout.join("")).toBe("Command passed: spctl\n");

    const failureStderr: string[] = [];
    const failureCli = createCli(
      { stdout: () => undefined, stderr: (chunk) => failureStderr.push(chunk) },
      { executeXcodeCommand: async () => ({ exitCode: 9, stdout: "", stderr: "rejected" }) }
    );

    await expect(failureCli(["xcode", "run", "--kind", "spctl", "--mode", "apply", "--path", "OuroMD.app"])).resolves.toBe(9);
    expect(failureStderr.join("")).toBe("Command failed: spctl exited 9\n");
  });

  it("returns structured xcode run option and executor errors", async () => {
    const invalidMode: string[] = [];
    const invalidModeCli = createCli({ stdout: (chunk) => invalidMode.push(chunk), stderr: () => undefined });
    await expect(invalidModeCli(["--json", "xcode", "run", "--mode", "live"])).resolves.toBe(64);
    expect(JSON.parse(invalidMode.join(""))).toEqual({
      ok: false,
      error: {
        code: "invalid_mode",
        message: "Unknown xcode run mode: live"
      }
    });

    const invalidKind: string[] = [];
    const invalidKindCli = createCli({ stdout: (chunk) => invalidKind.push(chunk), stderr: () => undefined });
    await expect(invalidKindCli(["--json", "xcode", "run", "--kind", "nope"])).resolves.toBe(64);
    expect(JSON.parse(invalidKind.join("")).error.code).toBe("invalid_kind");

    const missingOption: string[] = [];
    const missingOptionCli = createCli({ stdout: (chunk) => missingOption.push(chunk), stderr: () => undefined });
    await expect(
      missingOptionCli(["--json", "xcode", "run", "--kind", "codesign", "--path", "OuroMD.app", "--entitlements", "entitlements.plist"])
    ).resolves.toBe(64);
    expect(JSON.parse(missingOption.join(""))).toEqual({
      ok: false,
      error: {
        code: "missing_option",
        message: "xcode run requires --identity"
      }
    });

    const missingAuth: string[] = [];
    const missingAuthCli = createCli({ stdout: (chunk) => missingAuth.push(chunk), stderr: () => undefined });
    await expect(
      missingAuthCli(["--json", "xcode", "run", "--kind", "altool-upload", "--package-path", "OuroMD.pkg", "--api-key", "KEY"])
    ).resolves.toBe(64);
    expect(JSON.parse(missingAuth.join("")).error.message).toBe("xcode run altool API auth requires both --api-key and --api-issuer");

    const missingPackage: string[] = [];
    const missingPackageCli = createCli({ stdout: (chunk) => missingPackage.push(chunk), stderr: () => undefined });
    await expect(
      missingPackageCli(["--json", "xcode", "run", "--kind", "altool-upload", "--username", "ari@example.com", "--password", "app-password"])
    ).resolves.toBe(64);
    expect(JSON.parse(missingPackage.join("")).error.message).toBe("xcode run requires --package-path for altool commands");

    const missingAnyAuth: string[] = [];
    const missingAnyAuthCli = createCli({ stdout: (chunk) => missingAnyAuth.push(chunk), stderr: () => undefined });
    await expect(missingAnyAuthCli(["--json", "xcode", "run", "--kind", "altool-upload", "--package-path", "OuroMD.pkg"])).resolves.toBe(64);
    expect(JSON.parse(missingAnyAuth.join("")).error.message).toBe("xcode run altool commands require API key auth or --username and --password");

    const thrown: string[] = [];
    const thrownCli = createCli(
      { stdout: (chunk) => thrown.push(chunk), stderr: () => undefined },
      {
        executeXcodeCommand: async () => {
          throw new Error("tool missing");
        }
      }
    );
    await expect(thrownCli(["--json", "xcode", "run", "--kind", "spctl", "--mode", "apply", "--path", "OuroMD.app"])).resolves.toBe(69);
    expect(JSON.parse(thrown.join(""))).toEqual({
      ok: false,
      error: {
        code: "xcode_run_failed",
        message: "tool missing"
      }
    });
  });

  it("returns structured store review-plan errors", async () => {
    const dir = await makeTempDir();
    const manifestPath = join(dir, "apple-distribution.json");
    await writeFile(manifestPath, JSON.stringify(minimalManifest()));
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });

    await expect(
      cli(["--json", "store", "review-plan", "--manifest", manifestPath, "--channel", "missing"])
    ).resolves.toBe(65);
    expect(JSON.parse(stdout.join(""))).toEqual({
      ok: false,
      error: {
        code: "store_review_plan_failed",
        message: "App Store channel not found or incomplete: missing"
      }
    });
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

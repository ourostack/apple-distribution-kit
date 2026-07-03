import { describe, expect, it } from "vitest";
import {
  buildXcodeCommand,
  parseXcodeResult,
  runXcodeCommand,
  XcodeRunnerError
} from "../src/index.js";

describe("Xcode command generation", () => {
  it.each([
    [
      "codesign",
      { identity: "Developer ID Application: Ari", path: "Ouro MD.app", entitlements: "entitlements.plist" },
      ["codesign", "--force", "--options", "runtime", "--entitlements", "entitlements.plist", "--sign", "Developer ID Application: Ari", "Ouro MD.app"]
    ],
    [
      "productbuild",
      { identity: "3rd Party Mac Developer Installer: Ari", component: "Ouro MD.app", installLocation: "/Applications", output: "OuroMD.pkg" },
      ["productbuild", "--component", "Ouro MD.app", "/Applications", "--sign", "3rd Party Mac Developer Installer: Ari", "OuroMD.pkg"]
    ],
    ["notary-submit", { appleId: "ari@example.com", teamId: "TEAM", passwordKeychainItem: "notary-profile", packagePath: "OuroMD.zip" }, ["xcrun", "notarytool", "submit", "OuroMD.zip", "--apple-id", "ari@example.com", "--team-id", "TEAM", "--keychain-profile", "notary-profile", "--wait"]],
    ["stapler", { path: "Ouro MD.app" }, ["xcrun", "stapler", "staple", "Ouro MD.app"]],
    ["stapler-validate", { path: "Ouro MD.app" }, ["xcrun", "stapler", "validate", "Ouro MD.app"]],
    ["spctl", { path: "Ouro MD.app" }, ["spctl", "--assess", "--type", "execute", "Ouro MD.app"]],
    ["altool-validate", { packagePath: "OuroMD.pkg", apiKey: "KEY", apiIssuer: "issuer", providerPublicId: "123" }, ["xcrun", "altool", "--validate-app", "-f", "OuroMD.pkg", "--type", "macos", "--api-key", "KEY", "--api-issuer", "issuer", "--asc-provider", "123"]],
    ["altool-upload", { packagePath: "OuroMD.pkg", apiKey: "KEY", apiIssuer: "issuer", providerPublicId: "123" }, ["xcrun", "altool", "--upload-package", "OuroMD.pkg", "--type", "macos", "--api-key", "KEY", "--api-issuer", "issuer", "--asc-provider", "123", "--wait"]]
  ] as const)("builds %s argv", (kind, input, argv) => {
    expect(buildXcodeCommand({ kind, ...input })).toEqual({ kind, argv });
  });

  it("requires explicit apply intent for live commands", async () => {
    await expect(runXcodeCommand({ command: buildXcodeCommand({ kind: "spctl", path: "Ouro MD.app" }), mode: "dry-run" })).resolves.toEqual({
      ok: true,
      mode: "dry-run",
      command: ["spctl", "--assess", "--type", "execute", "Ouro MD.app"]
    });
  });

  it("runs apply commands through an injected executor", async () => {
    await expect(
      runXcodeCommand({
        command: buildXcodeCommand({ kind: "stapler-validate", path: "Ouro MD.app" }),
        mode: "apply",
        execute: async (argv) => ({ exitCode: 0, stdout: `ran ${argv.join(" ")}`, stderr: "" })
      })
    ).resolves.toEqual({
      ok: true,
      mode: "apply",
      command: ["xcrun", "stapler", "validate", "Ouro MD.app"],
      exitCode: 0,
      stdout: "ran xcrun stapler validate Ouro MD.app",
      stderr: ""
    });
  });
});

describe("Xcode result parsing", () => {
  it("classifies accepted notarization", () => {
    expect(parseXcodeResult({ kind: "notary-submit", exitCode: 0, stdout: "status: Accepted", stderr: "" })).toEqual({
      ok: true,
      status: "accepted"
    });
  });

  it("classifies rejected notarization", () => {
    expect(parseXcodeResult({ kind: "notary-submit", exitCode: 1, stdout: "status: Invalid", stderr: "bad signature" })).toEqual({
      ok: false,
      status: "invalid",
      message: "bad signature"
    });
  });

  it("throws typed errors for missing tools", async () => {
    await expect(
      runXcodeCommand({
        command: buildXcodeCommand({ kind: "spctl", path: "Ouro MD.app" }),
        mode: "apply",
        execute: async () => {
          throw new XcodeRunnerError("missing_tool", "spctl not found");
        }
      })
    ).rejects.toMatchObject({ code: "missing_tool", message: "spctl not found" });
  });

  it("throws typed errors when apply mode lacks an executor", async () => {
    await expect(
      runXcodeCommand({
        command: buildXcodeCommand({ kind: "spctl", path: "Ouro MD.app" }),
        mode: "apply"
      })
    ).rejects.toMatchObject({ code: "missing_executor" });
  });

  it("classifies generic command success and failure", () => {
    expect(parseXcodeResult({ kind: "spctl", exitCode: 0, stdout: "", stderr: "" })).toEqual({
      ok: true,
      status: "ok"
    });
    expect(parseXcodeResult({ kind: "spctl", exitCode: 1, stdout: "", stderr: "rejected" })).toEqual({
      ok: false,
      status: "failed",
      message: "rejected"
    });
  });
});

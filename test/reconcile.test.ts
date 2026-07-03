import { describe, expect, it } from "vitest";
import { reconcileAppleState } from "../src/index.js";

function manifest() {
  return {
    schemaVersion: 1 as const,
    app: { name: "Ouro MD", bundleId: "bot.ouro.md" },
    team: { teamId: "743GT2AJ24", providerPublicId: "123456789" },
    channels: [
      {
        id: "mac-app-store",
        platform: "macos" as const,
        distribution: "app-store" as const,
        bundleId: "bot.ouro.md",
        buildCommand: "build",
        packageCommand: "package",
        store: {
          version: "1.0",
          copyright: "Copyright 2026",
          category: "PRODUCTIVITY"
        }
      },
      {
        id: "direct",
        platform: "macos" as const,
        distribution: "developer-id" as const,
        bundleId: "bot.ouro.md",
        buildCommand: "build",
        packageCommand: "package"
      },
      {
        id: "ios-dry-run",
        platform: "ios" as const,
        distribution: "testflight" as const,
        bundleId: "app.spoonjoy",
        buildCommand: "build-ios",
        packageCommand: "package-ios"
      }
    ]
  };
}

describe("Apple state reconciliation", () => {
  it("plans missing Apple resources and first app record human gate", () => {
    expect(reconcileAppleState({ manifest: manifest(), remoteState: {} })).toEqual({
      ok: true,
      actions: [
        { type: "create-bundle-id", bundleId: "bot.ouro.md", platform: "MAC_OS" },
        { type: "create-certificate", certificateType: "MAC_APP_DISTRIBUTION" },
        { type: "create-certificate", certificateType: "MAC_INSTALLER_DISTRIBUTION" },
        { type: "create-profile", profileType: "MAC_APP_STORE", bundleId: "bot.ouro.md" },
        { type: "create-certificate", certificateType: "DEVELOPER_ID_APPLICATION" }
      ],
      requiresHuman: [
        {
          type: "requiresHuman",
          code: "first-app-record-required",
          message: "Create the first app record in App Store Connect.",
          url: "https://appstoreconnect.apple.com/apps",
          evidence: { bundleId: "bot.ouro.md", sku: undefined }
        }
      ],
      blockers: [
        {
          code: "ios-apply-not-supported",
          message: "iOS/TestFlight lanes are schema/dry-run only in this kit version.",
          evidence: { channelId: "ios-dry-run" }
        }
      ]
    });
  });

  it("does not plan resources already present remotely", () => {
    expect(
      reconcileAppleState({
        manifest: manifest(),
        remoteState: {
          bundleIds: [{ identifier: "bot.ouro.md", platform: "MAC_OS" }],
          certificates: [
            { certificateType: "MAC_APP_DISTRIBUTION" },
            { certificateType: "MAC_INSTALLER_DISTRIBUTION" },
            { certificateType: "DEVELOPER_ID_APPLICATION" }
          ],
          profiles: [{ profileType: "MAC_APP_STORE", bundleId: "bot.ouro.md" }],
          apps: [{ bundleId: "bot.ouro.md", id: "app-id" }]
        }
      }).actions
    ).toEqual([]);
  });

  it("refuses destructive deletes without the explicit flag", () => {
    expect(
      reconcileAppleState({
        manifest: manifest(),
        remoteState: {
          bundleIds: [
            { identifier: "bot.ouro.md", platform: "MAC_OS" },
            { identifier: "stale.example", platform: "MAC_OS" }
          ]
        }
      }).blockers
    ).toContainEqual({
      code: "destructive-delete-requires-flag",
      message: "Remote Apple resources not present in the manifest require --allow-destructive-apple-delete.",
      evidence: { resourceType: "bundleId", identifier: "stale.example" }
    });
  });

  it("plans destructive deletes only with the explicit flag", () => {
    expect(
      reconcileAppleState({
        manifest: manifest(),
        allowDestructiveAppleDelete: true,
        remoteState: {
          bundleIds: [
            { identifier: "bot.ouro.md", platform: "MAC_OS" },
            { identifier: "stale.example", platform: "MAC_OS" }
          ]
        }
      }).actions
    ).toContainEqual({ type: "delete-bundle-id", identifier: "stale.example" });
  });
});

import { describe, expect, it } from "vitest";
import { buildStoreRequests, planStoreSubmission } from "../src/index.js";

function manifestWithStore(overrides = {}) {
  return {
    schemaVersion: 1 as const,
    app: { name: "Ouro MD", bundleId: "bot.ouro.md", primaryLocale: "en-US" },
    team: { teamId: "TEAM", providerPublicId: "123" },
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
          category: "PRODUCTIVITY",
          screenshots: ["store-assets/mac/01-main.png"],
          privacy: { policyUrl: "https://ouro.bot/privacy", collectsData: false },
          exportCompliance: { usesEncryption: true, exempt: true },
          ...overrides
        }
      }
    ]
  };
}

describe("store request builder", () => {
  it("builds App Store version, localization, build association, and review submission requests", () => {
    expect(
      buildStoreRequests({
        appId: "app-123",
        versionId: "version-123",
        buildId: "build-123",
        manifest: manifestWithStore(),
        channelId: "mac-app-store"
      })
    ).toEqual([
      {
        method: "POST",
        path: "/v1/appStoreVersions",
        body: {
          data: {
            type: "appStoreVersions",
            attributes: { platform: "MAC_OS", versionString: "1.0" },
            relationships: { app: { data: { type: "apps", id: "app-123" } } }
          }
        }
      },
      {
        method: "PATCH",
        path: "/v1/appStoreVersions/version-123",
        body: {
          data: {
            type: "appStoreVersions",
            id: "version-123",
            relationships: { build: { data: { type: "builds", id: "build-123" } } }
          }
        }
      },
      {
        method: "POST",
        path: "/v1/reviewSubmissions",
        body: {
          data: {
            type: "reviewSubmissions",
            relationships: { app: { data: { type: "apps", id: "app-123" } } }
          }
        }
      }
    ]);
  });
});

describe("store submission planner", () => {
  it("blocks review prep when screenshot assets are missing", () => {
    expect(planStoreSubmission({ manifest: manifestWithStore({ screenshots: [] }), channelId: "mac-app-store" }).blockers).toContainEqual({
      code: "screenshots-assets-required",
      message: "Screenshots/app previews must exist locally or be proven present remotely before review submission.",
      evidence: { channelId: "mac-app-store" }
    });
  });

  it("blocks review prep when privacy or export compliance is missing", () => {
    expect(
      planStoreSubmission({
        manifest: manifestWithStore({ privacy: undefined, exportCompliance: undefined }),
        channelId: "mac-app-store"
      }).blockers
    ).toEqual([
      {
        code: "privacy-required",
        message: "Privacy metadata is required before review submission.",
        evidence: { channelId: "mac-app-store" }
      },
      {
        code: "export-compliance-required",
        message: "Export compliance metadata is required before review submission.",
        evidence: { channelId: "mac-app-store" }
      }
    ]);
  });

  it("plans review submission when required store metadata is present", () => {
    expect(planStoreSubmission({ manifest: manifestWithStore(), channelId: "mac-app-store" })).toEqual({
      ok: true,
      actions: [
        { type: "ensure-app-store-version", version: "1.0", platform: "MAC_OS" },
        { type: "ensure-localization", locale: "en-US" },
        { type: "associate-processed-build" },
        { type: "create-review-submission" }
      ],
      blockers: []
    });
  });
});

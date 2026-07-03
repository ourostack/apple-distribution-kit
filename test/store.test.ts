import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildStoreRequests, planStoreSubmission } from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "adk-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
  it("builds App Store version, build association, and review-submission-record requests", () => {
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

  it("throws when the requested App Store channel is missing", () => {
    expect(() =>
      buildStoreRequests({
        appId: "app-123",
        versionId: "version-123",
        buildId: "build-123",
        manifest: manifestWithStore(),
        channelId: "missing"
      })
    ).toThrow("App Store channel not found or incomplete: missing");
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
        manifest: manifestWithStore({
          screenshots: ["asc://screenshots/existing-main"],
          privacy: undefined,
          exportCompliance: undefined
        }),
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

  it("blocks when declared screenshot/app-preview files cannot be found", () => {
    expect(planStoreSubmission({ manifest: manifestWithStore(), channelId: "mac-app-store" }).blockers).toContainEqual({
      code: "store-assets-not-found",
      message: "Declared screenshots/app previews must exist locally or be represented by an explicit remote proof URI.",
      evidence: {
        channelId: "mac-app-store",
        missingAssets: ["store-assets/mac/01-main.png"]
      }
    });
  });

  it("does not accept arbitrary URI schemes as remote store proof", () => {
    expect(
      planStoreSubmission({
        manifest: manifestWithStore({ screenshots: ["file:///tmp/definitely-missing-ouro-md-store-shot.png"] }),
        channelId: "mac-app-store"
      }).blockers
    ).toContainEqual({
      code: "store-assets-not-found",
      message: "Declared screenshots/app previews must exist locally or be represented by an explicit remote proof URI.",
      evidence: {
        channelId: "mac-app-store",
        missingAssets: ["file:///tmp/definitely-missing-ouro-md-store-shot.png"]
      }
    });
  });

  it("plans only honest review-prep actions when local assets exist", async () => {
    const assetRoot = await makeTempDir();
    await writeFile(join(assetRoot, "01-main.png"), "fake png");

    expect(
      planStoreSubmission({
        manifest: manifestWithStore({ screenshots: ["01-main.png"] }),
        channelId: "mac-app-store",
        assetRoot
      })
    ).toEqual({
      ok: true,
      actions: [
        { type: "ensure-app-store-version", version: "1.0", platform: "MAC_OS" },
        { type: "associate-processed-build" },
        { type: "create-review-submission-record" }
      ],
      blockers: [
        {
          code: "localization-automation-required",
          message: "Localization metadata/update support must run before final App Review submission.",
          evidence: { channelId: "mac-app-store", locale: "en-US" }
        },
        {
          code: "review-submission-items-required",
          message: "Review submission items and final submit action must run after a processed build is selected.",
          evidence: { channelId: "mac-app-store" }
        }
      ]
    });
  });

  it("accepts absolute local store asset paths", async () => {
    const assetRoot = await makeTempDir();
    const screenshotPath = join(assetRoot, "absolute-main.png");
    await writeFile(screenshotPath, "fake png");

    expect(
      planStoreSubmission({
        manifest: manifestWithStore({ screenshots: [screenshotPath] }),
        channelId: "mac-app-store"
      }).blockers
    ).not.toContainEqual(
      expect.objectContaining({
        code: "store-assets-not-found"
      })
    );
  });

  it("accepts app previews as store asset proof and defaults locale", () => {
    const manifest = manifestWithStore({ screenshots: undefined, appPreviews: ["asc://appPreviews/existing-preview"] });
    manifest.app.primaryLocale = undefined;

    expect(planStoreSubmission({ manifest, channelId: "mac-app-store" })).toEqual({
      ok: true,
      actions: [
        { type: "ensure-app-store-version", version: "1.0", platform: "MAC_OS" },
        { type: "associate-processed-build" },
        { type: "create-review-submission-record" }
      ],
      blockers: [
        {
          code: "localization-automation-required",
          message: "Localization metadata/update support must run before final App Review submission.",
          evidence: { channelId: "mac-app-store", locale: "en-US" }
        },
        {
          code: "review-submission-items-required",
          message: "Review submission items and final submit action must run after a processed build is selected.",
          evidence: { channelId: "mac-app-store" }
        }
      ]
    });
  });
});

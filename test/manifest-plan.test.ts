import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPlan,
  createRequiresHuman,
  loadManifest,
  redactSecrets,
  validateManifestObject
} from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "adk-manifest-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function validManifest() {
  return {
    schemaVersion: 1,
    app: {
      name: "Ouro MD",
      bundleId: "bot.ouro.md",
      sku: "OURO-MD-MAC",
      primaryLocale: "en-US"
    },
    team: {
      teamId: "743GT2AJ24",
      providerPublicId: "123456789"
    },
    channels: [
      {
        id: "mac-app-store",
        platform: "macos",
        distribution: "app-store",
        bundleId: "bot.ouro.md",
        buildCommand: "swift build -c release",
        packageCommand: "scripts/package-app-store.sh --build-only",
        store: {
          version: "1.0",
          copyright: "Copyright 2026",
          category: "PRODUCTIVITY",
          screenshots: ["store-assets/mac/01-main.png"],
          privacy: {
            policyUrl: "https://ouro.bot/privacy",
            collectsData: false
          },
          exportCompliance: {
            usesEncryption: true,
            exempt: true
          }
        }
      },
      {
        id: "direct-download",
        platform: "macos",
        distribution: "developer-id",
        bundleId: "bot.ouro.md",
        buildCommand: "swift build -c release",
        packageCommand: "scripts/package-release.sh"
      }
    ]
  };
}

describe("manifest validation", () => {
  it("accepts the canonical manifest shape", () => {
    expect(validateManifestObject(validManifest())).toEqual({
      ok: true,
      manifest: validManifest()
    });
  });

  it("accepts TestFlight metadata for iOS beta channels", () => {
    const manifest = {
      ...validManifest(),
      channels: [
        {
          id: "ios-testflight",
          platform: "ios",
          distribution: "testflight",
          bundleId: "app.spoonjoy",
          buildCommand: "build-ios",
          packageCommand: "package-ios",
          testflight: {
            groups: [
              { name: "Internal", type: "internal", feedbackEnabled: true },
              { name: "External", type: "external", publicLinkEnabled: true, publicLinkLimit: 100 }
            ],
            build: { whatsNew: "Try the new beta.", autoNotifyEnabled: false, notifyTesters: true },
            betaApp: {
              description: "A friendly beta.",
              feedbackEmail: "beta@example.com",
              marketingUrl: "https://example.com",
              privacyPolicyUrl: "https://example.com/privacy"
            },
            betaReview: {
              contactFirstName: "Ari",
              contactLastName: "Mendelow",
              contactPhone: "+12065550100",
              contactEmail: "ari@example.com",
              demoAccountRequired: false,
              notes: "No login required."
            }
          }
        }
      ]
    };

    expect(validateManifestObject(manifest)).toEqual({ ok: true, manifest });
  });

  it("reports JSON-pointer-like validation errors", () => {
    const manifest = validManifest();
    manifest.channels[0]!.bundleId = "";

    expect(validateManifestObject(manifest)).toEqual({
      ok: false,
      errors: [
        {
          path: "/channels/0/bundleId",
          message: "Expected non-empty string"
        }
      ]
    });
  });

  it.each([
    [
      {
        ...validManifest(),
        channels: [
          { ...validManifest().channels[0], id: "duplicate" },
          { ...validManifest().channels[1], id: "duplicate" }
        ]
      },
      "/channels/1/id",
      "Duplicate channel id: duplicate"
    ],
    [
      { ...validManifest(), channels: [{ ...validManifest().channels[0], store: undefined }] },
      "/channels/0/store",
      "App Store channels require store metadata"
    ],
    [
      { ...validManifest(), channels: [{ ...validManifest().channels[1], platform: "ios" }] },
      "/channels/0/platform",
      "Developer ID channels are only supported for macOS"
    ],
    [
      {
        ...validManifest(),
        channels: [{ ...validManifest().channels[0], platform: "macos", distribution: "testflight" }]
      },
      "/channels/0/platform",
      "TestFlight channels are only supported for iOS"
    ],
    [
      {
        ...validManifest(),
        channels: [{ ...validManifest().channels[0], platform: "ios", distribution: "testflight" }]
      },
      "/channels/0/testflight",
      "TestFlight channels require testflight metadata"
    ],
    [
      {
        ...validManifest(),
        channels: [
          {
            ...validManifest().channels[0],
            platform: "ios",
            distribution: "testflight",
            testflight: null
          }
        ]
      },
      "/channels/0/testflight",
      "Expected object"
    ],
    [
      {
        ...validManifest(),
        channels: [
          {
            ...validManifest().channels[0],
            platform: "ios",
            distribution: "testflight",
            testflight: { groups: [] }
          }
        ]
      },
      "/channels/0/testflight/groups",
      "Expected non-empty array"
    ],
    [
      {
        ...validManifest(),
        channels: [
          {
            ...validManifest().channels[0],
            platform: "ios",
            distribution: "testflight",
            testflight: { groups: [null] }
          }
        ]
      },
      "/channels/0/testflight/groups/0",
      "Expected object"
    ],
    [
      {
        ...validManifest(),
        channels: [
          {
            ...validManifest().channels[0],
            platform: "ios",
            distribution: "testflight",
            testflight: { groups: [{ name: "Beta" }, { name: "Beta" }] }
          }
        ]
      },
      "/channels/0/testflight/groups/1/name",
      "Duplicate TestFlight group name: Beta"
    ],
    [
      {
        ...validManifest(),
        channels: [
          {
            ...validManifest().channels[0],
            platform: "ios",
            distribution: "testflight",
            testflight: { groups: [{ name: "Beta", publicLinkLimit: 0 }] }
          }
        ]
      },
      "/channels/0/testflight/groups/0/publicLinkLimit",
      "Expected integer between 1 and 10000"
    ],
    [
      {
        ...validManifest(),
        channels: [
          {
            ...validManifest().channels[0],
            platform: "ios",
            distribution: "testflight",
            testflight: { groups: [{ name: "Beta", publicLinkLimit: 10001 }] }
          }
        ]
      },
      "/channels/0/testflight/groups/0/publicLinkLimit",
      "Expected integer between 1 and 10000"
    ],
    [
      {
        ...validManifest(),
        channels: [
          {
            ...validManifest().channels[0],
            platform: "ios",
            distribution: "testflight",
            testflight: { groups: [{ name: "Beta" }], build: null }
          }
        ]
      },
      "/channels/0/testflight/build",
      "Expected object"
    ],
    [
      {
        ...validManifest(),
        channels: [
          {
            ...validManifest().channels[0],
            platform: "ios",
            distribution: "testflight",
            testflight: { groups: [{ name: "Beta" }], betaApp: null }
          }
        ]
      },
      "/channels/0/testflight/betaApp",
      "Expected object"
    ],
    [
      {
        ...validManifest(),
        channels: [
          {
            ...validManifest().channels[0],
            platform: "ios",
            distribution: "testflight",
            testflight: { groups: [{ name: "Beta" }], betaReview: null }
          }
        ]
      },
      "/channels/0/testflight/betaReview",
      "Expected object"
    ]
  ])("rejects semantic channel mismatch %#", (manifest, path, message) => {
    const result = validateManifestObject(manifest);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toContainEqual({ path, message });
  });

  it("loads manifests from disk", async () => {
    const dir = await makeTempDir();
    const manifestPath = join(dir, "apple-distribution.json");
    await writeFile(manifestPath, JSON.stringify(validManifest()));

    await expect(loadManifest(manifestPath)).resolves.toEqual(validManifest());
  });

  it("rejects invalid manifests loaded from disk", async () => {
    const dir = await makeTempDir();
    const manifestPath = join(dir, "apple-distribution.json");
    await writeFile(manifestPath, JSON.stringify({}));

    await expect(loadManifest(manifestPath)).rejects.toThrow("Invalid Apple distribution manifest");
  });

  it.each([
    [null, "/", "Expected object"],
    [{ ...validManifest(), schemaVersion: 2 }, "/schemaVersion", "Expected 1"],
    [{ ...validManifest(), app: null }, "/app", "Expected object"],
    [{ ...validManifest(), app: { ...validManifest().app, sku: "" } }, "/app/sku", "Expected non-empty string"],
    [
      { ...validManifest(), app: { ...validManifest().app, primaryLocale: "" } },
      "/app/primaryLocale",
      "Expected non-empty string"
    ],
    [{ ...validManifest(), team: null }, "/team", "Expected object"],
    [
      { ...validManifest(), team: { ...validManifest().team, providerPublicId: "" } },
      "/team/providerPublicId",
      "Expected non-empty string"
    ],
    [{ ...validManifest(), channels: [] }, "/channels", "Expected non-empty array"],
    [{ ...validManifest(), channels: "nope" }, "/channels", "Expected non-empty array"],
    [{ ...validManifest(), channels: [null] }, "/channels/0", "Expected object"],
    [
      { ...validManifest(), channels: [{ ...validManifest().channels[0], platform: "watchos" }] },
      "/channels/0/platform",
      "Expected one of: macos, ios"
    ],
    [
      { ...validManifest(), channels: [{ ...validManifest().channels[0], distribution: "enterprise" }] },
      "/channels/0/distribution",
      "Expected one of: app-store, developer-id, testflight"
    ],
    [
      { ...validManifest(), channels: [{ ...validManifest().channels[0], store: null }] },
      "/channels/0/store",
      "Expected object"
    ],
    [
      { ...validManifest(), channels: [{ ...validManifest().channels[0], store: { ...validManifest().channels[0]!.store, screenshots: "nope" } }] },
      "/channels/0/store/screenshots",
      "Expected array of non-empty strings"
    ],
    [
      { ...validManifest(), channels: [{ ...validManifest().channels[0], store: { ...validManifest().channels[0]!.store, screenshots: [""] } }] },
      "/channels/0/store/screenshots/0",
      "Expected non-empty string"
    ],
    [
      { ...validManifest(), channels: [{ ...validManifest().channels[0], store: { ...validManifest().channels[0]!.store, appPreviews: "nope" } }] },
      "/channels/0/store/appPreviews",
      "Expected array of non-empty strings"
    ],
    [
      { ...validManifest(), channels: [{ ...validManifest().channels[0], store: { ...validManifest().channels[0]!.store, privacy: null } }] },
      "/channels/0/store/privacy",
      "Expected object"
    ],
    [
      {
        ...validManifest(),
        channels: [
          {
            ...validManifest().channels[0],
            store: { ...validManifest().channels[0]!.store, privacy: { policyUrl: "", collectsData: "false" } }
          }
        ]
      },
      "/channels/0/store/privacy/policyUrl",
      "Expected non-empty string"
    ],
    [
      { ...validManifest(), channels: [{ ...validManifest().channels[0], store: { ...validManifest().channels[0]!.store, exportCompliance: null } }] },
      "/channels/0/store/exportCompliance",
      "Expected object"
    ],
    [
      {
        ...validManifest(),
        channels: [
          {
            ...validManifest().channels[0],
            store: { ...validManifest().channels[0]!.store, exportCompliance: { usesEncryption: "yes", exempt: "yes" } }
          }
        ]
      },
      "/channels/0/store/exportCompliance/usesEncryption",
      "Expected boolean"
    ]
  ])("reports validation error for %#", (manifest, path, message) => {
    const result = validateManifestObject(manifest);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toContainEqual({ path, message });
  });
});

describe("redaction", () => {
  it("redacts Apple secret material in nested logs", () => {
    expect(
      redactSecrets({
        token: "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiIxMjMifQ.signature",
        bundleId: "bot.ouro.md",
        apiUrl: "https://api.appstoreconnect.apple.com/v1/apps",
        privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        path: "/tmp/AuthKey_ABC123.p8",
        password: "abcd-efgh-ijkl-mnop",
        nested: ["safe", "AuthKey_ABC123.p8"]
      })
    ).toEqual({
      token: "[REDACTED_JWT]",
      bundleId: "bot.ouro.md",
      apiUrl: "https://api.appstoreconnect.apple.com/v1/apps",
      privateKey: "[REDACTED_PRIVATE_KEY]",
      path: "/tmp/[REDACTED_AUTH_KEY_FILE]",
      password: "[REDACTED_SECRET]",
      nested: ["safe", "[REDACTED_AUTH_KEY_FILE]"]
    });
  });

  it("returns primitive non-secret values unchanged", () => {
    expect(redactSecrets(7)).toBe(7);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets("safe")).toBe("safe");
  });
});

describe("plan shape", () => {
  it("creates stable dry-run plans", () => {
    expect(createPlan({ manifest: validManifest(), mode: "dry-run" })).toEqual({
      ok: true,
      mode: "dry-run",
      app: {
        name: "Ouro MD",
        bundleId: "bot.ouro.md"
      },
      actions: [
        {
          type: "validate-channel",
          channelId: "mac-app-store",
          distribution: "app-store"
        },
        {
          type: "build-channel",
          channelId: "mac-app-store",
          distribution: "app-store",
          command: "swift build -c release"
        },
        {
          type: "package-channel",
          channelId: "mac-app-store",
          distribution: "app-store",
          command: "scripts/package-app-store.sh --build-only"
        },
        {
          type: "validate-app-store-package",
          channelId: "mac-app-store",
          distribution: "app-store"
        },
        {
          type: "upload-app-store-package",
          channelId: "mac-app-store",
          distribution: "app-store"
        },
        {
          type: "prepare-app-review",
          channelId: "mac-app-store",
          distribution: "app-store"
        },
        {
          type: "validate-channel",
          channelId: "direct-download",
          distribution: "developer-id"
        },
        {
          type: "build-channel",
          channelId: "direct-download",
          distribution: "developer-id",
          command: "swift build -c release"
        },
        {
          type: "package-channel",
          channelId: "direct-download",
          distribution: "developer-id",
          command: "scripts/package-release.sh"
        },
        {
          type: "sign-notarize-direct-download",
          channelId: "direct-download",
          distribution: "developer-id"
        },
        {
          type: "publish-direct-download",
          channelId: "direct-download",
          distribution: "developer-id"
        }
      ],
      requiresHuman: []
    });
  });

  it("includes TestFlight upload actions for iOS channels", () => {
    const manifest = {
      ...validManifest(),
      channels: [
        {
          id: "ios-testflight",
          platform: "ios",
          distribution: "testflight",
          bundleId: "bot.ouro.md",
          buildCommand: "xcodebuild archive",
          packageCommand: "xcodebuild -exportArchive"
        }
      ]
    } as const;

    expect(createPlan({ manifest, mode: "dry-run" }).actions).toEqual([
      {
        type: "validate-channel",
        channelId: "ios-testflight",
        distribution: "testflight"
      },
      {
        type: "build-channel",
        channelId: "ios-testflight",
        distribution: "testflight",
        command: "xcodebuild archive"
      },
      {
        type: "package-channel",
        channelId: "ios-testflight",
        distribution: "testflight",
        command: "xcodebuild -exportArchive"
      },
      {
        type: "upload-testflight-build",
        channelId: "ios-testflight",
        distribution: "testflight"
      }
    ]);
  });

  it("standardizes requiresHuman entries", () => {
    expect(
      createRequiresHuman({
        code: "first-app-record-required",
        message: "Create the first app record in App Store Connect.",
        url: "https://appstoreconnect.apple.com/apps",
        evidence: { bundleId: "bot.ouro.md" }
      })
    ).toEqual({
      type: "requiresHuman",
      code: "first-app-record-required",
      message: "Create the first app record in App Store Connect.",
      url: "https://appstoreconnect.apple.com/apps",
      evidence: { bundleId: "bot.ouro.md" }
    });
  });
});

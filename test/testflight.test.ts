import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppStoreConnectError,
  buildTestFlightRequests,
  createAppStoreConnectClient,
  executeTestFlightRequests,
  planTestFlightSubmission,
  publishTestFlightRequests
} from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "adk-testflight-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function manifest(overrides = {}) {
  return {
    schemaVersion: 1 as const,
    app: { name: "Spoonjoy", bundleId: "app.spoonjoy", primaryLocale: "en-US" },
    team: { teamId: "743GT2AJ24", providerPublicId: "9735080289" },
    channels: [
      {
        id: "ios-testflight",
        platform: "ios" as const,
        distribution: "testflight" as const,
        bundleId: "app.spoonjoy",
        buildCommand: "yarn rw build web && yarn cap sync",
        packageCommand: "xcodebuild archive",
        store: {
          version: "1.0",
          copyright: "Copyright 2026",
          category: "FOOD_AND_DRINK",
          privacy: { policyUrl: "https://spoonjoy.app/privacy", collectsData: true },
          exportCompliance: { usesEncryption: true, exempt: true }
        },
        testflight: {
          groups: [
            { name: "Spoonjoy Internal", type: "internal" as const, feedbackEnabled: true },
            {
              name: "Spoonjoy Friends",
              type: "external" as const,
              publicLinkEnabled: true,
              publicLinkLimitEnabled: true,
              publicLinkLimit: 100,
              feedbackEnabled: true
            }
          ],
          build: { whatsNew: "Try the pantry-friendly recipe flow.", autoNotifyEnabled: false, notifyTesters: true },
          betaApp: {
            description: "Spoonjoy helps you turn what you have into something worth eating.",
            feedbackEmail: "beta@spoonjoy.app",
            marketingUrl: "https://spoonjoy.app"
          },
          betaReview: {
            contactFirstName: "Ari",
            contactLastName: "Mendelow",
            contactPhone: "+12065550100",
            contactEmail: "ari@example.com",
            demoAccountRequired: false,
            notes: "No login is required for the first beta build."
          },
          ...overrides
        }
      }
    ]
  };
}

describe("TestFlight submission planner", () => {
  it("plans a complete internal and external beta lane", () => {
    expect(planTestFlightSubmission({ manifest: manifest(), channelId: "ios-testflight" })).toEqual({
      ok: true,
      actions: [
        { type: "upload-testflight-build", channelId: "ios-testflight", platform: "IOS" },
        { type: "wait-for-processed-build", channelId: "ios-testflight", platform: "IOS" },
        { type: "set-build-export-compliance", channelId: "ios-testflight", platform: "IOS" },
        { type: "ensure-beta-app-localization", channelId: "ios-testflight", platform: "IOS", locale: "en-US" },
        { type: "configure-beta-groups", channelId: "ios-testflight", platform: "IOS", groupCount: 2 },
        { type: "attach-build-to-beta-groups", channelId: "ios-testflight", platform: "IOS", groupCount: 2 },
        { type: "set-beta-build-test-info", channelId: "ios-testflight", platform: "IOS", locale: "en-US" },
        {
          type: "configure-beta-review-detail",
          channelId: "ios-testflight",
          platform: "IOS",
          externalGroupCount: 1
        },
        {
          type: "submit-external-beta-review",
          channelId: "ios-testflight",
          platform: "IOS",
          externalGroupCount: 1
        },
        { type: "notify-beta-testers", channelId: "ios-testflight", platform: "IOS" }
      ],
      blockers: []
    });
  });

  it("blocks missing TestFlight essentials before publishing", () => {
    const blocked = manifest({
      groups: [],
      build: {},
      betaReview: { demoAccountRequired: true }
    });
    blocked.team.providerPublicId = undefined;
    blocked.channels[0]!.store = { ...blocked.channels[0]!.store, exportCompliance: undefined };

    expect(planTestFlightSubmission({ manifest: blocked, channelId: "ios-testflight" }).blockers).toEqual([
      {
        code: "testflight-groups-required",
        message: "Declare at least one TestFlight beta group before publishing.",
        evidence: { channelId: "ios-testflight" }
      },
      {
        code: "testflight-whats-new-required",
        message: "TestFlight builds need tester-facing what-to-test notes.",
        evidence: { channelId: "ios-testflight", locale: "en-US" }
      },
      {
        code: "export-compliance-required",
        message: "Export compliance metadata is required before TestFlight distribution.",
        evidence: { channelId: "ios-testflight" }
      },
      {
        code: "provider-public-id-required",
        message: "Add providerPublicId to the manifest so upload commands can disambiguate the Apple provider.",
        evidence: { teamId: "743GT2AJ24" }
      }
    ]);
  });

  it("treats absent group arrays as a planning blocker", () => {
    const absentGroups = manifest({ groups: undefined });

    expect(planTestFlightSubmission({ manifest: absentGroups, channelId: "ios-testflight" }).blockers).toContainEqual({
      code: "testflight-groups-required",
      message: "Declare at least one TestFlight beta group before publishing.",
      evidence: { channelId: "ios-testflight" }
    });
  });

  it("plans a simple internal-only lane without external review or notifications", () => {
    const internalOnly = manifest({
      groups: [{ name: "Spoonjoy Internal", type: "internal" as const }],
      build: { whatsNew: "Internal notes only." }
    });

    expect(planTestFlightSubmission({ manifest: internalOnly, channelId: "ios-testflight" })).toEqual({
      ok: true,
      actions: [
        { type: "upload-testflight-build", channelId: "ios-testflight", platform: "IOS" },
        { type: "wait-for-processed-build", channelId: "ios-testflight", platform: "IOS" },
        { type: "set-build-export-compliance", channelId: "ios-testflight", platform: "IOS" },
        { type: "ensure-beta-app-localization", channelId: "ios-testflight", platform: "IOS", locale: "en-US" },
        { type: "configure-beta-groups", channelId: "ios-testflight", platform: "IOS", groupCount: 1 },
        { type: "attach-build-to-beta-groups", channelId: "ios-testflight", platform: "IOS", groupCount: 1 },
        { type: "set-beta-build-test-info", channelId: "ios-testflight", platform: "IOS", locale: "en-US" }
      ],
      blockers: []
    });
  });

  it("blocks external beta review when contact or demo credentials are missing", () => {
    const blocked = manifest({
      groups: [{ name: "External", type: "external" as const }],
      build: { whatsNew: "External beta notes." },
      betaReview: { contactFirstName: "Ari", demoAccountRequired: true }
    });

    expect(planTestFlightSubmission({ manifest: blocked, channelId: "ios-testflight" }).blockers).toEqual([
      {
        code: "beta-review-contact-required",
        message: "External TestFlight groups require beta review contact details.",
        evidence: {
          channelId: "ios-testflight",
          missingFields: ["contactLastName", "contactPhone", "contactEmail"]
        }
      },
      {
        code: "beta-review-demo-account-required",
        message: "Beta review demo credentials are required when demoAccountRequired is true.",
        evidence: { channelId: "ios-testflight" }
      }
    ]);
  });

  it("uses beta app privacy metadata and falls back to en-US when app locale is absent", () => {
    const noLocale = manifest({
      groups: [{ name: "Untyped Group" }],
      build: { whatsNew: "No locale manifest." },
      betaApp: { privacyPolicyUrl: "https://beta.spoonjoy.app/privacy", feedbackEmail: "beta@spoonjoy.app" }
    });
    noLocale.app.primaryLocale = undefined;

    expect(planTestFlightSubmission({ manifest: noLocale, channelId: "ios-testflight" }).actions).toContainEqual({
      type: "ensure-beta-app-localization",
      channelId: "ios-testflight",
      platform: "IOS",
      locale: "en-US"
    });
    expect(
      buildTestFlightRequests({
        manifest: noLocale,
        channelId: "ios-testflight",
        appId: "app-123",
        buildId: "build-123"
      })
    ).toContainEqual({
      method: "POST",
      path: "/v1/betaGroups",
      body: {
        data: {
          type: "betaGroups",
          attributes: { name: "Untyped Group" },
          relationships: {
            app: { data: { type: "apps", id: "app-123" } },
            builds: { data: [{ type: "builds", id: "build-123" }] }
          }
        }
      }
    });
  });

  it("blocks demo review credentials when only the password is missing", () => {
    const blocked = manifest({
      groups: [{ name: "External", type: "external" as const }],
      build: { whatsNew: "External beta notes." },
      betaReview: {
        contactFirstName: "Ari",
        contactLastName: "Mendelow",
        contactPhone: "+12065550100",
        contactEmail: "ari@example.com",
        demoAccountRequired: true,
        demoAccountName: "demo@example.com"
      }
    });

    expect(planTestFlightSubmission({ manifest: blocked, channelId: "ios-testflight" }).blockers).toContainEqual({
      code: "beta-review-demo-account-required",
      message: "Beta review demo credentials are required when demoAccountRequired is true.",
      evidence: { channelId: "ios-testflight" }
    });
  });
});

describe("TestFlight request builder", () => {
  it("builds official App Store Connect requests for groups, build notes, review, and notifications", () => {
    expect(
      buildTestFlightRequests({
        manifest: manifest(),
        channelId: "ios-testflight",
        appId: "app-123",
        buildId: "build-123",
        buildBetaDetailId: "beta-detail-123",
        betaAppReviewDetailId: "review-detail-123",
        groupIdsByName: { "Spoonjoy Internal": "group-1" }
      })
    ).toEqual([
      {
        method: "PATCH",
        path: "/v1/builds/build-123",
        body: {
          data: {
            type: "builds",
            id: "build-123",
            attributes: { usesNonExemptEncryption: false }
          }
        }
      },
      {
        method: "POST",
        path: "/v1/betaAppLocalizations",
        body: {
          data: {
            type: "betaAppLocalizations",
            attributes: {
              locale: "en-US",
              description: "Spoonjoy helps you turn what you have into something worth eating.",
              feedbackEmail: "beta@spoonjoy.app",
              marketingUrl: "https://spoonjoy.app",
              privacyPolicyUrl: "https://spoonjoy.app/privacy"
            },
            relationships: { app: { data: { type: "apps", id: "app-123" } } }
          }
        }
      },
      {
        method: "POST",
        path: "/v1/betaGroups/group-1/relationships/builds",
        body: { data: [{ type: "builds", id: "build-123" }] }
      },
      {
        method: "POST",
        path: "/v1/betaGroups",
        body: {
          data: {
            type: "betaGroups",
            attributes: {
              name: "Spoonjoy Friends",
              isInternalGroup: false,
              publicLinkEnabled: true,
              publicLinkLimitEnabled: true,
              publicLinkLimit: 100,
              feedbackEnabled: true
            },
            relationships: {
              app: { data: { type: "apps", id: "app-123" } },
              builds: { data: [{ type: "builds", id: "build-123" }] }
            }
          }
        }
      },
      {
        method: "POST",
        path: "/v1/betaBuildLocalizations",
        body: {
          data: {
            type: "betaBuildLocalizations",
            attributes: { locale: "en-US", whatsNew: "Try the pantry-friendly recipe flow." },
            relationships: { build: { data: { type: "builds", id: "build-123" } } }
          }
        }
      },
      {
        method: "PATCH",
        path: "/v1/buildBetaDetails/beta-detail-123",
        body: {
          data: {
            type: "buildBetaDetails",
            id: "beta-detail-123",
            attributes: { autoNotifyEnabled: false }
          }
        }
      },
      {
        method: "PATCH",
        path: "/v1/betaAppReviewDetails/review-detail-123",
        body: {
          data: {
            type: "betaAppReviewDetails",
            id: "review-detail-123",
            attributes: {
              contactFirstName: "Ari",
              contactLastName: "Mendelow",
              contactPhone: "+12065550100",
              contactEmail: "ari@example.com",
              demoAccountRequired: false,
              notes: "No login is required for the first beta build."
            }
          }
        }
      },
      {
        method: "POST",
        path: "/v1/betaAppReviewSubmissions",
        body: {
          data: {
            type: "betaAppReviewSubmissions",
            relationships: { build: { data: { type: "builds", id: "build-123" } } }
          }
        }
      },
      {
        method: "POST",
        path: "/v1/buildBetaNotifications",
        body: {
          data: {
            type: "buildBetaNotifications",
            relationships: { build: { data: { type: "builds", id: "build-123" } } }
          }
        }
      }
    ]);
  });

  it("requires dependent App Store Connect IDs only when the manifest needs them", () => {
    expect(() =>
      buildTestFlightRequests({
        manifest: manifest(),
        channelId: "ios-testflight",
        appId: "app-123",
        buildId: "build-123"
      })
    ).toThrow("buildBetaDetailId is required");

    expect(() =>
      buildTestFlightRequests({
        manifest: manifest({ build: { whatsNew: "Notes" } }),
        channelId: "ios-testflight",
        appId: "app-123",
        buildId: "build-123"
      })
    ).toThrow("betaAppReviewDetailId is required");
  });

  it("rejects missing TestFlight channels", () => {
    expect(() =>
      buildTestFlightRequests({
        manifest: manifest(),
        channelId: "missing",
        appId: "app-123",
        buildId: "build-123"
      })
    ).toThrow("TestFlight channel not found or incomplete: missing");
  });

  it("creates internal groups when no existing group id is supplied", () => {
    const internal = manifest({
      groups: [{ name: "Spoonjoy Internal", type: "internal" as const }],
      build: { whatsNew: "Internal build notes." }
    });

    expect(
      buildTestFlightRequests({
        manifest: internal,
        channelId: "ios-testflight",
        appId: "app-123",
        buildId: "build-123"
      })
    ).toContainEqual({
      method: "POST",
      path: "/v1/betaGroups",
      body: {
        data: {
          type: "betaGroups",
          attributes: { name: "Spoonjoy Internal", isInternalGroup: true },
          relationships: {
            app: { data: { type: "apps", id: "app-123" } },
            builds: { data: [{ type: "builds", id: "build-123" }] }
          }
        }
      }
    });
  });
});

describe("TestFlight request execution", () => {
  it("executes requests sequentially through the ASC client and redacts responses", async () => {
    const calls: string[] = [];
    const client = createAppStoreConnectClient({
      auth: {
        issuerId: "issuer",
        keyId: "KEY",
        privateKeyPem: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
      },
      fetch: async (url, init) => {
        calls.push(`${init?.method} ${String(url)} ${init?.body}`);
        return new Response(JSON.stringify({ token: "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiIxMjMifQ.signature" }), { status: 200 });
      }
    });

    await expect(
      executeTestFlightRequests({
        client,
        requests: [{ method: "POST", path: "/v1/buildBetaNotifications", body: { data: { type: "buildBetaNotifications" } } }]
      })
    ).resolves.toEqual({ ok: true, results: [{ token: "[REDACTED_JWT]" }] });
    expect(calls).toEqual([
      'POST https://api.appstoreconnect.apple.com/v1/buildBetaNotifications {"data":{"type":"buildBetaNotifications"}}'
    ]);
  });

  it("skips build export compliance PATCH requests when the desired value is already set", async () => {
    const calls: string[] = [];
    const client: Parameters<typeof executeTestFlightRequests>[0]["client"] = {
      get: async (path: string) => {
        calls.push(`GET ${path}`);
        return {
          data: {
            type: "builds",
            id: "build-123",
            attributes: { usesNonExemptEncryption: false }
          }
        };
      },
      request: async (input) => {
        calls.push(`${input.method} ${input.path}`);
        return { ok: true };
      }
    };

    await expect(
      executeTestFlightRequests({
        client,
        requests: [
          {
            method: "PATCH",
            path: "/v1/builds/build-123",
            body: {
              data: {
                type: "builds",
                id: "build-123",
                attributes: { usesNonExemptEncryption: false }
              }
            }
          },
          {
            method: "POST",
            path: "/v1/buildBetaNotifications",
            body: { data: { type: "buildBetaNotifications" } }
          }
        ]
      })
    ).resolves.toEqual({
      ok: true,
      results: [
        {
          ok: true,
          skipped: true,
          path: "/v1/builds/build-123",
          reason: "build-export-compliance-already-set",
          usesNonExemptEncryption: false
        },
        { ok: true }
      ]
    });
    expect(calls).toEqual(["GET /v1/builds/build-123", "POST /v1/buildBetaNotifications"]);
  });

  it("patches existing TestFlight localizations and skips already attached group builds", async () => {
    const calls: string[] = [];
    const client: Parameters<typeof executeTestFlightRequests>[0]["client"] = {
      get: async (path: string) => {
        calls.push(`GET ${path}`);
        if (path === "/v1/apps/app-123/betaAppLocalizations") {
          return {
            data: [
              {
                type: "betaAppLocalizations",
                id: "app-loc-1",
                attributes: { locale: "en-US" }
              }
            ]
          };
        }
        if (path === "/v1/betaGroups/group-1/relationships/builds") {
          return {
            data: [{ type: "builds", id: "build-123" }]
          };
        }
        if (path === "/v1/builds/build-123/betaBuildLocalizations") {
          return {
            data: [
              {
                type: "betaBuildLocalizations",
                id: "build-loc-1",
                attributes: { locale: "en-US" }
              }
            ]
          };
        }
        throw new Error(`unexpected GET ${path}`);
      },
      request: async (input) => {
        calls.push(`${input.method} ${input.path} ${JSON.stringify(input.body)}`);
        return { ok: true };
      }
    };

    await expect(
      executeTestFlightRequests({
        client,
        requests: [
          {
            method: "POST",
            path: "/v1/betaAppLocalizations",
            body: {
              data: {
                type: "betaAppLocalizations",
                attributes: { locale: "en-US", description: "Spoonjoy", feedbackEmail: "beta@spoonjoy.app" },
                relationships: { app: { data: { type: "apps", id: "app-123" } } }
              }
            }
          },
          {
            method: "POST",
            path: "/v1/betaGroups/group-1/relationships/builds",
            body: { data: [{ type: "builds", id: "build-123" }] }
          },
          {
            method: "POST",
            path: "/v1/betaBuildLocalizations",
            body: {
              data: {
                type: "betaBuildLocalizations",
                attributes: { locale: "en-US", whatsNew: "Internal dogfood." },
                relationships: { build: { data: { type: "builds", id: "build-123" } } }
              }
            }
          }
        ]
      })
    ).resolves.toEqual({
      ok: true,
      results: [
        { ok: true },
        {
          ok: true,
          skipped: true,
          path: "/v1/betaGroups/group-1/relationships/builds",
          reason: "beta-group-build-relationship-already-set",
          buildIds: ["build-123"]
        },
        { ok: true }
      ]
    });
    expect(calls).toEqual([
      "GET /v1/apps/app-123/betaAppLocalizations",
      'PATCH /v1/betaAppLocalizations/app-loc-1 {"data":{"type":"betaAppLocalizations","id":"app-loc-1","attributes":{"description":"Spoonjoy","feedbackEmail":"beta@spoonjoy.app"}}}',
      "GET /v1/betaGroups/group-1/relationships/builds",
      "GET /v1/builds/build-123/betaBuildLocalizations",
      'PATCH /v1/betaBuildLocalizations/build-loc-1 {"data":{"type":"betaBuildLocalizations","id":"build-loc-1","attributes":{"whatsNew":"Internal dogfood."}}}'
    ]);
  });

  it("treats already enabled TestFlight notifications as an idempotent publish result", async () => {
    const calls: string[] = [];
    const client: Parameters<typeof executeTestFlightRequests>[0]["client"] = {
      get: async (path: string) => {
        calls.push(`GET ${path}`);
        if (path === "/v1/buildBetaDetails/build-123") {
          return {
            data: {
              type: "buildBetaDetails",
              id: "build-123",
              attributes: {
                autoNotifyEnabled: true,
                internalBuildState: "IN_BETA_TESTING"
              }
            }
          };
        }
        throw new Error(`unexpected GET ${path}`);
      },
      request: async (input) => {
        calls.push(`${input.method} ${input.path} ${JSON.stringify(input.body)}`);
        throw new AppStoreConnectError({
          status: 409,
          code: "STATE_ERROR",
          message: "There is a problem with the request entity",
          retryable: true
        });
      }
    };

    await expect(
      executeTestFlightRequests({
        client,
        requests: [
          {
            method: "POST",
            path: "/v1/buildBetaNotifications",
            body: {
              data: {
                type: "buildBetaNotifications",
                relationships: { build: { data: { type: "builds", id: "build-123" } } }
              }
            }
          }
        ]
      })
    ).resolves.toEqual({
      ok: true,
      results: [
        {
          ok: true,
          skipped: true,
          path: "/v1/buildBetaNotifications",
          reason: "beta-notification-already-enabled-or-in-testing",
          buildId: "build-123",
          status: 409,
          code: "STATE_ERROR",
          message: "There is a problem with the request entity",
          autoNotifyEnabled: true,
          internalBuildState: "IN_BETA_TESTING"
        }
      ]
    });
    expect(calls).toEqual([
      'POST /v1/buildBetaNotifications {"data":{"type":"buildBetaNotifications","relationships":{"build":{"data":{"type":"builds","id":"build-123"}}}}}',
      "GET /v1/buildBetaDetails/build-123"
    ]);
  });

  it("does not swallow TestFlight notification conflicts until Apple state proves the build is available", async () => {
    const client: Parameters<typeof executeTestFlightRequests>[0]["client"] = {
      get: async () => ({
        data: {
          type: "buildBetaDetails",
          id: "build-123",
          attributes: {
            autoNotifyEnabled: false,
            internalBuildState: "PROCESSING"
          }
        }
      }),
      request: async () => {
        throw new AppStoreConnectError({
          status: 409,
          code: "STATE_ERROR",
          message: "There is a problem with the request entity",
          retryable: true
        });
      }
    };

    await expect(
      executeTestFlightRequests({
        client,
        requests: [
          {
            method: "POST",
            path: "/v1/buildBetaNotifications",
            body: {
              data: {
                type: "buildBetaNotifications",
                relationships: { build: { data: { type: "builds", id: "build-123" } } }
              }
            }
          }
        ]
      })
    ).rejects.toMatchObject({
      name: "AppStoreConnectError",
      status: 409,
      code: "STATE_ERROR"
    });
  });

  it("publishes requests from an on-disk ASC config", async () => {
    const dir = await makeTempDir();
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const keyPath = join(dir, "AuthKey_TEST.p8");
    const configPath = join(dir, "config.json");
    await writeFile(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    await writeFile(configPath, JSON.stringify({ issuerId: "issuer", keyId: "KEY", privateKeyPath: keyPath }));

    await expect(
      publishTestFlightRequests({
        configPath,
        requests: [{ method: "POST", path: "/v1/buildBetaNotifications", body: { data: { type: "buildBetaNotifications" } } }],
        fetch: async () => new Response(null, { status: 204 }),
        now: new Date("2026-07-04T12:00:00Z")
      })
    ).resolves.toEqual({ ok: true, results: [{ ok: true }] });
  });

  it("publishes requests with global fetch when no fetch override is supplied", async () => {
    const dir = await makeTempDir();
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const keyPath = join(dir, "AuthKey_TEST.p8");
    const configPath = join(dir, "config.json");
    const originalFetch = globalThis.fetch;
    await writeFile(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    await writeFile(configPath, JSON.stringify({ issuerId: "issuer", keyId: "KEY", privateKeyPath: keyPath }));
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;

    try {
      await expect(
        publishTestFlightRequests({
          configPath,
          requests: [{ method: "POST", path: "/v1/buildBetaNotifications", body: { data: { type: "buildBetaNotifications" } } }]
        })
      ).resolves.toEqual({ ok: true, results: [{ data: [] }] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppStoreConnectClient } from "../src/asc.js";
import { createCli } from "../src/cli-core.js";
import {
  readReviewMessages,
  readReviewStatus,
  readReviewStatusFromConfig,
  reviewHtmlToText,
  reviewTransition,
  type ReviewWebGet
} from "../src/review.js";

function fakeClient(routes: Record<string, unknown>, calls: string[] = []): AppStoreConnectClient {
  const get = async (path: string, query: Record<string, string> = {}) => {
    const key = `${path}${query["filter[platform]"] ? `#${query["filter[platform]"]}` : ""}`;
    calls.push(key);
    return routes[key] ?? { data: [] };
  };
  return { get, request: async (input) => get(input.path, input.query) };
}

const statusRoutes = {
  "/v1/apps": { data: [{ id: "APP" }] },
  "/v1/apps/APP/appStoreVersions#IOS": {
    data: [
      { id: "v1", attributes: { versionString: "1.0", appStoreState: "REJECTED", releaseType: "AFTER_APPROVAL" } },
      { id: "v0", attributes: { versionString: "0.9", appVersionState: "READY_FOR_DISTRIBUTION" } },
      { id: "vx", attributes: null }
    ]
  },
  "/v1/reviewSubmissions#IOS": {
    data: [
      { id: "S1", attributes: { state: "UNRESOLVED_ISSUES", submittedDate: "2026-10-25T10:08:40Z" } },
      { id: "S0" }
    ]
  },
  "/v1/apps/APP/appStoreVersions#MAC_OS": { data: [{ id: "m1", attributes: { versionString: "1.0", appStoreState: "WAITING_FOR_REVIEW" } }] },
  "/v1/reviewSubmissions#MAC_OS": "not a body"
};

describe("readReviewStatus", () => {
  it("reads every version and review submission on both platforms", async () => {
    const status = await readReviewStatus(fakeClient(statusRoutes), { bundleId: "app.example" });
    expect(status).toEqual({
      appId: "APP",
      versions: [
        { platform: "IOS", version: "1.0", state: "REJECTED", releaseType: "AFTER_APPROVAL" },
        { platform: "IOS", version: "0.9", state: "READY_FOR_DISTRIBUTION" },
        { platform: "IOS", version: "", state: "UNKNOWN" },
        { platform: "MAC_OS", version: "1.0", state: "WAITING_FOR_REVIEW" }
      ],
      submissions: [
        { id: "S1", platform: "IOS", state: "UNRESOLVED_ISSUES", submittedDate: "2026-10-25T10:08:40Z" },
        { id: "S0", platform: "IOS", state: "UNKNOWN" }
      ]
    });
  });

  it("reads only the platforms asked for", async () => {
    const calls: string[] = [];
    await readReviewStatus(fakeClient(statusRoutes, calls), { bundleId: "app.example", platforms: ["MAC_OS"] });
    expect(calls).toEqual(["/v1/apps", "/v1/apps/APP/appStoreVersions#MAC_OS", "/v1/reviewSubmissions#MAC_OS"]);
  });

  it("refuses an unknown bundle ID", async () => {
    await expect(readReviewStatus(fakeClient({}), { bundleId: "app.none" })).rejects.toThrow("No App Store Connect app has bundle ID app.none");
  });
});

describe("reviewTransition", () => {
  const t = (previous: string | undefined, current: string) => reviewTransition(previous, current, "IOS 1.0");

  it("announces nothing without a change", () => {
    expect(t("IN_REVIEW", "IN_REVIEW")).toBeNull();
  });

  it("names each kind of change", () => {
    expect(t("IN_REVIEW", "REJECTED")).toMatchObject({ kind: "rejected", close: false });
    expect(t(undefined, "METADATA_REJECTED")?.kind).toBe("rejected");
    expect(t("IN_REVIEW", "PENDING_DEVELOPER_RELEASE")?.kind).toBe("approved");
    expect(t("IN_REVIEW", "PENDING_APPLE_RELEASE")?.kind).toBe("releasing");
    expect(t("PENDING_APPLE_RELEASE", "READY_FOR_SALE")).toMatchObject({ kind: "live", close: true });
    expect(t("WAITING_FOR_REVIEW", "IN_REVIEW")?.kind).toBe("in-review");
    expect(t("IN_REVIEW", "DEVELOPER_REJECTED")?.message).toBe("IOS 1.0 changed from IN_REVIEW to DEVELOPER_REJECTED.");
    expect(t(undefined, "DEVELOPER_REJECTED")?.message).toBe("IOS 1.0 changed from unknown to DEVELOPER_REJECTED.");
  });

  it("calls out a resubmission after a rejection", () => {
    expect(t("REJECTED", "WAITING_FOR_REVIEW")?.message).toBe("IOS 1.0 is waiting for review again after a resubmission.");
    expect(t("PREPARE_FOR_SUBMISSION", "WAITING_FOR_REVIEW")?.message).toBe("IOS 1.0 is waiting for review.");
    expect(t(undefined, "WAITING_FOR_REVIEW")?.message).toBe("IOS 1.0 is waiting for review.");
  });
});

describe("reviewHtmlToText", () => {
  it("keeps paragraphs and list items and decodes entities", () => {
    const html = "<p>Guideline 2.1 &amp; Performance</p><p>We found:<br/>a crash &lt;on launch&gt;.</p><ul><li>Step &quot;one&quot;</li><li>It&#39;s&nbsp;fine &apos;ok&apos;</li></ul><div></div><p></p><p></p><p>End</p>";
    expect(reviewHtmlToText(html)).toBe("Guideline 2.1 & Performance\nWe found:\na crash <on launch>.\n- Step \"one\"\n- It's fine 'ok'\n\nEnd");
  });
});

function webGet(routes: Record<string, { status: number; body?: unknown }>, calls: string[] = []): ReviewWebGet {
  return async (path) => {
    calls.push(path);
    const route = routes[path] ?? { status: 404 };
    return { status: route.status, body: route.body };
  };
}

describe("readReviewMessages", () => {
  const messagesPath = "/iris/v1/resolutionCenterThreads/T1/resolutionCenterMessages?include=fromActor,rejections";

  it("reads the messages and rejection reasons of a submission's threads", async () => {
    const calls: string[] = [];
    const result = await readReviewMessages(
      webGet({
        "/iris/v1/resolutionCenterThreads?filter[reviewSubmission]=S%201": { status: 200, body: { data: [{ id: "T1" }] } },
        [messagesPath]: {
          status: 200,
          body: {
            data: [
              { attributes: { createdDate: "2026-10-26T03:38:00Z", messageBody: "<p>Guideline 4.0</p>" } },
              { attributes: {} }
            ],
            included: [
              { type: "reviewRejections", attributes: { reasons: [{ section: "4.0" }] } },
              { type: "actors", attributes: { name: "Apple" } }
            ]
          }
        }
      }, calls),
      { appId: "APP", submissionId: "S 1" }
    );
    expect(calls).toEqual(["/iris/v1/resolutionCenterThreads?filter[reviewSubmission]=S%201", messagesPath]);
    expect(result).toEqual({
      ok: true,
      messages: [
        { threadId: "T1", createdDate: "2026-10-26T03:38:00Z", text: "Guideline 4.0" },
        { threadId: "T1", text: "" }
      ],
      rejections: [{ reasons: [{ section: "4.0" }] }]
    });
  });

  it("lists the app's threads when no submission is given", async () => {
    const calls: string[] = [];
    const result = await readReviewMessages(webGet({ "/iris/v1/apps/APP/resolutionCenterThreads": { status: 200, body: {} } }, calls), { appId: "APP" });
    expect(calls).toEqual(["/iris/v1/apps/APP/resolutionCenterThreads"]);
    expect(result).toEqual({ ok: true, messages: [], rejections: [] });
  });

  it("asks for a human sign-in when the session is missing", async () => {
    const result = await readReviewMessages(webGet({ "/iris/v1/apps/APP/resolutionCenterThreads": { status: 401 } }), { appId: "APP" });
    expect(result).toMatchObject({ ok: false, status: 401, requiresHuman: { type: "requiresHuman", code: "app_store_connect_web_session_required" } });
  });

  it("stops when a thread's messages are refused", async () => {
    const result = await readReviewMessages(
      webGet({ "/iris/v1/apps/APP/resolutionCenterThreads": { status: 200, body: { data: [{ id: "T1" }] } }, [messagesPath]: { status: 403 } }),
      { appId: "APP" }
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
  });
});

describe("review status command", () => {
  const status = {
    appId: "APP",
    versions: [{ platform: "IOS" as const, version: "1.0", state: "REJECTED" }],
    submissions: [
      { id: "S1", platform: "IOS" as const, state: "UNRESOLVED_ISSUES", submittedDate: "2026-10-25T10:08:40Z" },
      { id: "S0", platform: "IOS" as const, state: "COMPLETE" }
    ]
  };

  function cliWith(readReviewStatusImpl: typeof readReviewStatusFromConfig) {
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined }, { readReviewStatus: readReviewStatusImpl });
    return { cli, stdout };
  }

  it("prints each version and submission", async () => {
    const seen: unknown[] = [];
    const { cli, stdout } = cliWith(async (input) => {
      seen.push(input);
      return status;
    });
    await expect(cli(["review", "status", "--bundle-id", "app.example", "--platform", "IOS", "--config", "/c.json"])).resolves.toBe(0);
    expect(seen).toEqual([{ configPath: "/c.json", bundleId: "app.example", platforms: ["IOS"] }]);
    expect(stdout.join("")).toBe(
      "IOS 1.0: REJECTED (rejected)\n" +
      "Review submission S1 (IOS): UNRESOLVED_ISSUES, submitted 2026-10-25T10:08:40Z\n" +
      "Review submission S0 (IOS): COMPLETE\n"
    );
  });

  it("prints JSON and reads both platforms by default", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { cli, stdout } = cliWith(async (input) => {
      seen.push(input as Record<string, unknown>);
      return status;
    });
    await expect(cli(["--json", "review", "status", "--bundle-id", "app.example"])).resolves.toBe(0);
    expect(seen[0]!.platforms).toBeUndefined();
    expect(JSON.parse(stdout.join(""))).toEqual({ ok: true, result: status });
  });

  it("rejects missing or unknown arguments and reports failures", async () => {
    const { cli, stdout } = cliWith(async () => {
      throw new Error("HTTP 401");
    });
    await expect(cli(["--json", "review", "status"])).resolves.toBe(64);
    expect(JSON.parse(stdout.splice(0).join("")).error.code).toBe("missing_bundle_id");
    await expect(cli(["--json", "review", "status", "--bundle-id", "a", "--platform", "TV_OS"])).resolves.toBe(64);
    expect(JSON.parse(stdout.splice(0).join("")).error.code).toBe("invalid_platform");
    await expect(cli(["--json", "review", "status", "--bundle-id", "a"])).resolves.toBe(69);
    expect(JSON.parse(stdout.splice(0).join("")).error).toEqual({ code: "review_status_failed", message: "HTTP 401" });
  });

  it("reads status through the default App Store Connect client", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adk-review-"));
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const keyPath = join(dir, "AuthKey_TEST.p8");
    const configPath = join(dir, "config.json");
    await writeFile(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    await writeFile(configPath, JSON.stringify({ issuerId: "issuer", keyId: "KEY", privateKeyPath: keyPath }));
    const fetchImpl = (async (url: URL) =>
      new Response(JSON.stringify(url.pathname === "/v1/apps" ? { data: [{ id: "APP" }] } : { data: [] }), { status: 200 })) as unknown as typeof fetch;
    try {
      await expect(readReviewStatusFromConfig({ configPath, bundleId: "app.example", platforms: ["IOS"], fetch: fetchImpl }))
        .resolves.toEqual({ appId: "APP", versions: [], submissions: [] });
      await expect(readReviewStatusFromConfig({ configPath, bundleId: "app.example", fetch: fetchImpl }))
        .resolves.toEqual({ appId: "APP", versions: [], submissions: [] });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchImpl;
      try {
        await expect(readReviewStatusFromConfig({ configPath, bundleId: "app.example", platforms: ["IOS"] }))
          .resolves.toEqual({ appId: "APP", versions: [], submissions: [] });
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the built-in reader when no dependency is given", async () => {
    const stdout: string[] = [];
    const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: () => undefined });
    await expect(cli(["--json", "review", "status"])).resolves.toBe(64);
  });
});

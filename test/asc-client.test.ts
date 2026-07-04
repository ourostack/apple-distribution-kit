import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppStoreConnectError,
  createAppStoreConnectClient,
  getAppStoreConnect,
  loadAscAuth,
  resolveProviderPublicId,
  signAppStoreConnectJwt,
  smokeAppStoreConnect
} from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "adk-asc-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function decodePart(token: string, index: number) {
  const part = token.split(".")[index]!;
  return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

describe("App Store Connect JWT", () => {
  it("signs ES256 JWTs with P-1363 signatures", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const token = signAppStoreConnectJwt({
      issuerId: "issuer-id",
      keyId: "KEY123",
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      now: new Date("2026-07-03T12:00:00Z"),
      durationSeconds: 1200
    });

    expect(decodePart(token, 0)).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });
    expect(decodePart(token, 1)).toEqual({
      iss: "issuer-id",
      iat: 1783080000,
      exp: 1783081200,
      aud: "appstoreconnect-v1"
    });
    const [header, payload, signature] = token.split(".");
    expect(Buffer.from(signature!.replace(/-/g, "+").replace(/_/g, "/"), "base64")).toHaveLength(64);
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { key: publicKey.export({ format: "pem", type: "spki" }).toString(), dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!.replace(/-/g, "+").replace(/_/g, "/"), "base64")
      )
    ).toBe(true);
  });

  it("uses default issue time and duration when omitted", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const before = Math.floor(Date.now() / 1000);
    const token = signAppStoreConnectJwt({
      issuerId: "issuer-id",
      keyId: "KEY123",
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    });
    const after = Math.floor(Date.now() / 1000);
    const payload = decodePart(token, 1);

    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(after);
    expect(payload.exp - payload.iat).toBe(1200);
  });

  it("loads auth config and private key from disk", async () => {
    const dir = await makeTempDir();
    const keyPath = join(dir, "AuthKey_TEST.p8");
    const configPath = join(dir, "config.json");
    await writeFile(keyPath, "PRIVATE KEY");
    await writeFile(configPath, JSON.stringify({ issuerId: "issuer", keyId: "KEY", privateKeyPath: keyPath }));

    await expect(loadAscAuth(configPath)).resolves.toEqual({
      issuerId: "issuer",
      keyId: "KEY",
      privateKeyPem: "PRIVATE KEY"
    });
  });
});

describe("App Store Connect client", () => {
  it("captures outgoing request shape for GET calls", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createAppStoreConnectClient({
      auth: {
        issuerId: "issuer",
        keyId: "KEY",
        privateKeyPem: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
      },
      now: new Date("2026-07-03T12:00:00Z"),
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });

    await expect(client.get("/v1/apps", { limit: "1" })).resolves.toEqual({ data: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.appstoreconnect.apple.com/v1/apps?limit=1");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.headers).toMatchObject({
      Accept: "application/json"
    });
    expect(String((calls[0]!.init.headers as Record<string, string>).Authorization)).toMatch(/^Bearer /);
  });

  it("captures outgoing JSON request shape for mutation calls", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createAppStoreConnectClient({
      auth: {
        issuerId: "issuer",
        keyId: "KEY",
        privateKeyPem: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
      },
      now: new Date("2026-07-03T12:00:00Z"),
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(null, { status: 204 });
      }
    });

    await expect(
      client.request({
        method: "POST",
        path: "/v1/betaBuildLocalizations",
        body: { data: { type: "betaBuildLocalizations" } }
      })
    ).resolves.toEqual({ ok: true });
    expect(calls[0]!.url).toBe("https://api.appstoreconnect.apple.com/v1/betaBuildLocalizations");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({
      Accept: "application/json",
      "Content-Type": "application/json"
    });
    expect(calls[0]!.init.body).toBe('{"data":{"type":"betaBuildLocalizations"}}');
  });

  it("classifies retryable and non-retryable Apple errors", async () => {
    const client = createAppStoreConnectClient({
      auth: {
        issuerId: "issuer",
        keyId: "KEY",
        privateKeyPem: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
      },
      fetch: async () =>
        new Response(JSON.stringify({ errors: [{ code: "RATE_LIMIT", title: "Slow down" }] }), {
          status: 429,
          headers: { "content-type": "application/json" }
        })
    });

    await expect(client.get("/v1/apps")).rejects.toMatchObject({
      name: "AppStoreConnectError",
      status: 429,
      code: "RATE_LIMIT",
      retryable: true
    });
  });

  it.each([408, 409, 425, 500])("marks HTTP %s as retryable", async (status) => {
    const client = createAppStoreConnectClient({
      auth: {
        issuerId: "issuer",
        keyId: "KEY",
        privateKeyPem: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
      },
      fetch: async () => new Response(JSON.stringify({}), { status })
    });

    await expect(client.get("/v1/apps")).rejects.toMatchObject({ retryable: true, code: "apple_error" });
  });

  it("uses fallback Apple error strings when error fields are missing", async () => {
    const client = createAppStoreConnectClient({
      auth: {
        issuerId: "issuer",
        keyId: "KEY",
        privateKeyPem: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
      },
      fetch: async () => new Response(JSON.stringify({ errors: [{}] }), { status: 400 })
    });

    await expect(client.get("/v1/apps")).rejects.toMatchObject({
      status: 400,
      code: "apple_error",
      message: "Apple request failed",
      retryable: false
    });
  });

  it("supports global fetch and custom base URLs", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: "1" }] }), { status: 200 });
    }) as typeof fetch;
    const client = createAppStoreConnectClient({
      auth: {
        issuerId: "issuer",
        keyId: "KEY",
        privateKeyPem: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
      },
      baseUrl: "https://example.test"
    });

    try {
      await expect(client.get("/v1/apps")).resolves.toEqual({ data: [{ id: "1" }] });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toEqual(["https://example.test/v1/apps"]);
  });

  it("classifies malformed successful responses", async () => {
    const client = createAppStoreConnectClient({
      auth: {
        issuerId: "issuer",
        keyId: "KEY",
        privateKeyPem: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
      },
      fetch: async () => new Response("not-json", { status: 200 })
    });

    await expect(client.get("/v1/apps")).rejects.toBeInstanceOf(AppStoreConnectError);
    await expect(client.get("/v1/apps")).rejects.toMatchObject({ code: "invalid_json", retryable: false });
  });

  it("runs smoke with redacted results", async () => {
    const dir = await makeTempDir();
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const keyPath = join(dir, "AuthKey_TEST.p8");
    const configPath = join(dir, "config.json");
    await writeFile(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    await writeFile(configPath, JSON.stringify({ issuerId: "issuer", keyId: "KEY", privateKeyPath: keyPath }));

    await expect(
      smokeAppStoreConnect({
        configPath,
        fetch: async () =>
          new Response(JSON.stringify({ data: [], token: "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiIxMjMifQ.signature" }), {
            status: 200
          })
      })
    ).resolves.toEqual({ data: [], token: "[REDACTED_JWT]" });
  });

  it("runs smoke with global fetch and explicit time", async () => {
    const dir = await makeTempDir();
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const keyPath = join(dir, "AuthKey_TEST.p8");
    const configPath = join(dir, "config.json");
    const originalFetch = globalThis.fetch;
    await writeFile(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    await writeFile(configPath, JSON.stringify({ issuerId: "issuer", keyId: "KEY", privateKeyPath: keyPath }));
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;

    try {
      await expect(smokeAppStoreConnect({ configPath, now: new Date("2026-07-03T12:00:00Z") })).resolves.toEqual({
        data: []
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runs authenticated GET helpers with query parameters and redaction", async () => {
    const dir = await makeTempDir();
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const calls: string[] = [];
    const keyPath = join(dir, "AuthKey_TEST.p8");
    const configPath = join(dir, "config.json");
    await writeFile(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    await writeFile(configPath, JSON.stringify({ issuerId: "issuer", keyId: "KEY", privateKeyPath: keyPath }));

    await expect(
      getAppStoreConnect({
        configPath,
        path: "/v1/builds",
        query: { "filter[app]": "app-123", sort: "-uploadedDate" },
        now: new Date("2026-07-04T12:00:00Z"),
        fetch: async (url) => {
          calls.push(String(url));
          return new Response(JSON.stringify({ token: "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiIxMjMifQ.signature" }), { status: 200 });
        }
      })
    ).resolves.toEqual({ token: "[REDACTED_JWT]" });
    expect(calls).toEqual([
      "https://api.appstoreconnect.apple.com/v1/builds?filter%5Bapp%5D=app-123&sort=-uploadedDate"
    ]);
  });
});

describe("provider resolution", () => {
  it("uses manifest providerPublicId when present", () => {
    expect(resolveProviderPublicId({ team: { teamId: "TEAM", providerPublicId: "123456789" } })).toEqual({
      ok: true,
      providerPublicId: "123456789"
    });
  });

  it("requires a human/configuration blocker when providerPublicId is missing", () => {
    expect(resolveProviderPublicId({ team: { teamId: "TEAM" } })).toEqual({
      ok: false,
      requiresHuman: {
        type: "requiresHuman",
        code: "provider-public-id-required",
        message: "Add providerPublicId to the app manifest for Transporter/altool upload commands.",
        evidence: { teamId: "TEAM" }
      }
    });
  });

  it("treats blank providerPublicId as missing", () => {
    expect(resolveProviderPublicId({ team: { teamId: "TEAM", providerPublicId: " " } }).ok).toBe(false);
  });
});

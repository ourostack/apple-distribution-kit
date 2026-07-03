import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppStoreConnectError,
  createAppStoreConnectClient,
  loadAscAuth,
  resolveProviderPublicId,
  signAppStoreConnectJwt
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
});

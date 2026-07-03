import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { redactSecrets } from "./redaction.js";
import { createRequiresHuman, type RequiresHuman } from "./plan.js";

export interface AscAuth {
  issuerId: string;
  keyId: string;
  privateKeyPem: string;
}

export interface JwtInput extends AscAuth {
  now?: Date;
  durationSeconds?: number;
}

export interface AppStoreConnectClientOptions {
  auth: AscAuth;
  fetch?: typeof fetch;
  now?: Date;
  baseUrl?: string;
}

export interface AppStoreConnectClient {
  get: (path: string, query?: Record<string, string>) => Promise<unknown>;
}

export class AppStoreConnectError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(input: { status: number; code: string; message: string; retryable: boolean }) {
    super(input.message);
    this.name = "AppStoreConnectError";
    this.status = input.status;
    this.code = input.code;
    this.retryable = input.retryable;
  }
}

export async function loadAscAuth(configPath: string): Promise<AscAuth> {
  const config = await loadConfig(configPath);
  return {
    issuerId: config.issuerId,
    keyId: config.keyId,
    privateKeyPem: await readFile(config.privateKeyPath, "utf8")
  };
}

export function signAppStoreConnectJwt(input: JwtInput): string {
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const duration = input.durationSeconds ?? 20 * 60;
  const header = { alg: "ES256", kid: input.keyId, typ: "JWT" };
  const payload = {
    iss: input.issuerId,
    iat: now,
    exp: now + duration,
    aud: "appstoreconnect-v1"
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: createPrivateKey(input.privateKeyPem),
    dsaEncoding: "ieee-p1363"
  });
  return `${signingInput}.${base64Url(signature)}`;
}

export function createAppStoreConnectClient(options: AppStoreConnectClientOptions): AppStoreConnectClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.appstoreconnect.apple.com";
  return {
    get: async (path, query = {}) => {
      const url = new URL(path, baseUrl);
      Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
      const token = signAppStoreConnectJwt(options.now ? { ...options.auth, now: options.now } : options.auth);
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`
        }
      });
      return parseResponse(response);
    }
  };
}

export type ProviderResolution =
  | { ok: true; providerPublicId: string }
  | { ok: false; requiresHuman: RequiresHuman };

export function resolveProviderPublicId(manifest: { team: { teamId: string; providerPublicId?: string } }): ProviderResolution {
  if (manifest.team.providerPublicId && manifest.team.providerPublicId.trim() !== "") {
    return { ok: true, providerPublicId: manifest.team.providerPublicId };
  }
  return {
    ok: false,
    requiresHuman: createRequiresHuman({
      code: "provider-public-id-required",
      message: "Add providerPublicId to the app manifest for Transporter/altool upload commands.",
      evidence: { teamId: manifest.team.teamId }
    })
  };
}

export async function smokeAppStoreConnect(input: { configPath: string; fetch?: typeof fetch; now?: Date }): Promise<unknown> {
  const auth = await loadAscAuth(input.configPath);
  const client = createAppStoreConnectClient({
    auth,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.now ? { now: input.now } : {})
  });
  const result = await client.get("/v1/apps", { limit: "1" });
  return redactSecrets(result);
}

async function parseResponse(response: Response): Promise<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    throw new AppStoreConnectError({
      status: response.status,
      code: "invalid_json",
      message: "App Store Connect returned invalid JSON",
      retryable: false
    });
  }

  if (!response.ok) {
    const error = firstAppleError(parsed);
    throw new AppStoreConnectError({
      status: response.status,
      code: error.code,
      message: error.title,
      retryable: retryableStatus(response.status)
    });
  }

  return parsed;
}

function firstAppleError(parsed: unknown): { code: string; title: string } {
  if (isRecord(parsed) && Array.isArray(parsed.errors) && isRecord(parsed.errors[0])) {
    return {
      code: typeof parsed.errors[0].code === "string" ? parsed.errors[0].code : "apple_error",
      title: typeof parsed.errors[0].title === "string" ? parsed.errors[0].title : "Apple request failed"
    };
  }
  return { code: "apple_error", title: "Apple request failed" };
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

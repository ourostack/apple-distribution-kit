import { DeveloperError, DeveloperSession, developerReadUrl, validateDeveloperId, type DeveloperReadPath } from "./developer-session.js";
export { DeveloperError } from "./developer-session.js";
export type { DeveloperErrorCode } from "./developer-session.js";

export interface DeveloperKeySummary {
  keyId: string;
  keyName: string;
  serviceIds: string[];
  canDownload: boolean;
  canRevoke: boolean;
}
export interface DeveloperClientOptions {
  teamId: string;
  session: DeveloperSession;
  fetch?: typeof globalThis.fetch;
}
export interface DeveloperClient {
  status(): Promise<{ ready: true; teamId: string }>;
  keys: {
    list(): Promise<DeveloperKeySummary[]>;
    get(keyId: string): Promise<DeveloperKeySummary>;
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function summary(value: unknown): DeveloperKeySummary {
  if (!record(value) || !text(value.keyId, 10) || !/^[A-Z0-9]{10}$/.test(value.keyId) ||
    !text(value.keyName, 256) || !Array.isArray(value.services) || value.services.length > 100 ||
    typeof value.canDownload !== "boolean" || typeof value.canRevoke !== "boolean") throw new DeveloperError("invalid_response");
  const serviceIds = value.services.map(service => {
    if (!record(service) || !text(service.id, 128) || !/^[A-Za-z0-9_.-]+$/.test(service.id)) throw new DeveloperError("invalid_response");
    return service.id;
  });
  return { keyId: value.keyId, keyName: value.keyName, serviceIds, canDownload: value.canDownload, canRevoke: value.canRevoke };
}

function loginRedirect(location: string | null): boolean {
  if (!location) return false;
  try {
    const url = new URL(location, "https://developer.apple.com/");
    return url.protocol === "https:" && !url.username && !url.password &&
      (url.hostname === "idmsa.apple.com" || (url.hostname === "developer.apple.com" && /^\/(login|signin|account)(\/|$)/.test(url.pathname)));
  } catch { return false; }
}

export function createDeveloperClient(options: DeveloperClientOptions): DeveloperClient {
  validateDeveloperId(options.teamId);
  if (!(options.session instanceof DeveloperSession)) throw new DeveloperError("invalid_session");
  if (options.session.teamId !== options.teamId) throw new DeveloperError("team_mismatch");
  const fetcher = options.fetch ?? globalThis.fetch;
  async function read(path: DeveloperReadPath, fields: Record<string, string>): Promise<DeveloperKeySummary[]> {
    const cookie = options.session.cookieHeader(path);
    let response: Response;
    try {
      response = await fetcher(developerReadUrl(path), {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", cookie },
        body: new URLSearchParams({ teamId: options.teamId, ...fields })
      });
    } catch { throw new DeveloperError("network_error"); }
    if (response.redirected || (response.url && response.url !== developerReadUrl(path))) throw new DeveloperError("redirect_rejected");
    if (response.status >= 300 && response.status < 400) {
      throw new DeveloperError(loginRedirect(response.headers.get("location")) ? "sign_in_required" : "redirect_rejected");
    }
    if (response.status === 401) throw new DeveloperError("sign_in_required");
    if (response.status === 403) throw new DeveloperError("permission_denied");
    if (response.status !== 200) throw new DeveloperError("http_error");
    const contentType = response.headers.get("content-type") ?? "";
    if (/text\/html/i.test(contentType)) throw new DeveloperError("sign_in_required");
    if (!/^application\/json(?:;|$)/i.test(contentType)) throw new DeveloperError("invalid_response");
    let data: unknown;
    try { data = await response.json(); } catch { throw new DeveloperError("invalid_response"); }
    if (!record(data) || typeof data.resultCode !== "number" || !Number.isSafeInteger(data.resultCode)) throw new DeveloperError("invalid_response");
    if (data.resultCode === 2100) throw new DeveloperError("agreement_required");
    if (data.resultCode !== 0) throw new DeveloperError("apple_error");
    if (!Array.isArray(data.keys) || data.keys.length > 50) throw new DeveloperError("invalid_response");
    const keys = data.keys.map(summary);
    options.session.refresh(path, response.headers.getSetCookie());
    return keys;
  }
  return {
    async status() {
      await read("account/auth/key/list", { pageNumber: "1", pageSize: "50", sort: "name=asc" });
      return { ready: true, teamId: options.teamId };
    },
    keys: {
      async get(keyId) {
        validateDeveloperId(keyId);
        const keys = await read("account/auth/key/get", { keyId });
        if (keys.length !== 1 || keys[0]!.keyId !== keyId) throw new DeveloperError("invalid_response");
        return keys[0]!;
      },
      async list() {
        const result: DeveloperKeySummary[] = [];
        const seen = new Set<string>();
        for (let page = 1; page <= 100; page++) {
          const keys = await read("account/auth/key/list", { pageNumber: String(page), pageSize: "50", sort: "name=asc" });
          for (const key of keys) {
            if (seen.has(key.keyId)) throw new DeveloperError("pagination_non_progress");
            seen.add(key.keyId);
            result.push(key);
          }
          if (keys.length < 50) return result;
        }
        throw new DeveloperError("pagination_limit");
      }
    }
  };
}

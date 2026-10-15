import { DeveloperError, DeveloperSession, validateDeveloperId, type DeveloperReadPath } from "./developer-session.js";
import { createDeveloperTransport, developerRecord as record } from "./developer-transport.js";
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

export function createDeveloperClient(options: DeveloperClientOptions): DeveloperClient {
  validateDeveloperId(options.teamId);
  const transport = createDeveloperTransport(options);
  async function read(path: DeveloperReadPath, fields: Record<string, string>, keyId?: string): Promise<DeveloperKeySummary[]> {
    const response = await transport.request(path, { fields });
    const data = response.data as Record<string, unknown>;
    if (!Array.isArray(data.keys) || data.keys.length > 50) throw new DeveloperError("invalid_response");
    const keys = data.keys.map(summary);
    if (keyId !== undefined && (keys.length !== 1 || keys[0]!.keyId !== keyId)) throw new DeveloperError("invalid_response");
    response.accept();
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
        const keys = await read("account/auth/key/get", { keyId }, keyId);
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

import {
  DeveloperError, DeveloperSession, developerTransportAccess, developerTransportUrl,
  type DeveloperTransportPath
} from "./developer-session.js";

export function developerRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function developerApiResult(value: unknown): Record<string, unknown> {
  if (!developerRecord(value) || typeof value.resultCode !== "number" || !Number.isSafeInteger(value.resultCode)) {
    throw new DeveloperError("invalid_response");
  }
  if (value.resultCode === 2100) throw new DeveloperError("agreement_required");
  if (value.resultCode !== 0) throw new DeveloperError("apple_error");
  return value;
}

function loginRedirect(location: string | null): boolean {
  if (!location) return false;
  try {
    const url = new URL(location, "https://developer.apple.com/");
    return url.protocol === "https:" && !url.username && !url.password &&
      (url.hostname === "idmsa.apple.com" || (url.hostname === "developer.apple.com" && /^\/(login|signin|account)(\/|$)/.test(url.pathname)));
  } catch { return false; }
}

export interface DeveloperTransport {
  request(path: DeveloperTransportPath, options: {
    method?: "POST" | "GET" | "PATCH";
    fields?: Record<string, string>;
    json?: unknown;
    csrf?: { csrf: string; csrf_ts: string };
    binary?: boolean;
  }): Promise<{ data: unknown; headers: Headers; accept(): void }>;
}

/** Pinned internal transport. The package exports only resource-bound lifecycle APIs. */
export function createDeveloperTransport(options: {
  teamId: string; session: DeveloperSession; fetch?: typeof globalThis.fetch;
}): DeveloperTransport {
  if (!(options.session instanceof DeveloperSession)) throw new DeveloperError("invalid_session");
  if (options.session.teamId !== options.teamId) throw new DeveloperError("team_mismatch");
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async request(path, input) {
      const url = developerTransportUrl(path);
      const cookie = options.session[developerTransportAccess](path);
      const service = path.startsWith("service:") || path.startsWith("service-update:");
      const bundle = path.startsWith("bundle:") || service;
      if ((input.method === "PATCH") !== path.startsWith("service-update:")) throw new DeveloperError("invalid_arguments");
      const headers: Record<string, string> = { accept: input.binary ? "application/octet-stream" : "application/json", cookie };
      if (input.method !== "GET") headers["content-type"] = bundle ? "application/vnd.api+json" :
        input.json === undefined ? "application/x-www-form-urlencoded" : "application/json";
      if (bundle) {
        headers["X-Requested-With"] = "XMLHttpRequest";
        if (input.method !== "PATCH") headers["X-HTTP-Method-Override"] = "GET";
      }
      if (input.csrf) {
        if (!/^[\x21-\x7e]{1,1024}$/.test(input.csrf.csrf) || !/^[0-9]{1,32}$/.test(input.csrf.csrf_ts)) {
          throw new DeveloperError("invalid_response");
        }
        Object.assign(headers, input.csrf);
      }
      let response: Response;
      const signal = AbortSignal.timeout(15_000);
      try {
        response = await fetcher(url, {
          method: input.method ?? "POST", redirect: "manual", signal, headers,
          ...(input.method === "GET" ? {} : { body: input.json === undefined ?
            new URLSearchParams({ teamId: options.teamId, ...input.fields }) : JSON.stringify(input.json) })
        });
      } catch { throw new DeveloperError("network_error"); }
      if (response.redirected || (response.url && response.url !== url)) throw new DeveloperError("redirect_rejected");
      if (response.status >= 300 && response.status < 400) {
        throw new DeveloperError(loginRedirect(response.headers.get("location")) ? "sign_in_required" : "redirect_rejected");
      }
      if (response.status === 401) throw new DeveloperError("sign_in_required");
      if (response.status === 403) throw new DeveloperError("permission_denied");
      if (response.status !== 200) throw new DeveloperError("http_error");
      const contentType = response.headers.get("content-type") ?? "";
      if (/text\/html/i.test(contentType)) throw new DeveloperError("sign_in_required");
      if (!input.binary && !(bundle ? /^application\/(?:json|vnd\.api\+json)(?:;|$)/i :
        /^application\/json(?:;|$)/i).test(contentType)) throw new DeveloperError("invalid_response");
      const limit = input.binary ? 16_384 : 1024 * 1024;
      const reader = response.body?.getReader();
      if (!reader) throw new DeveloperError("invalid_response");
      let buffer: Buffer;
      let abortListener: (() => void) | undefined;
      try {
        if (signal.aborted) {
          void reader.cancel().catch(() => {});
          throw new DeveloperError("network_error");
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        // Also bound injected transports whose streams do not honor the request's signal.
        const abort = new Promise<never>((_, reject) => {
          abortListener = () => {
            reject(new DeveloperError("network_error"));
            void reader.cancel().catch(() => {});
          };
          signal.addEventListener("abort", abortListener, { once: true });
        });
        for (;;) {
          const item = await Promise.race([reader.read(), abort]);
          if (item.done) break;
          size += item.value.byteLength;
          if (size > limit) { void reader.cancel().catch(() => {}); throw new DeveloperError("invalid_response"); }
          chunks.push(item.value);
        }
        buffer = Buffer.concat(chunks, size);
      } catch (error) {
        if (error instanceof DeveloperError) throw error;
        throw new DeveloperError("invalid_response");
      } finally {
        if (abortListener) signal.removeEventListener("abort", abortListener);
        reader.releaseLock();
      }
      let data: unknown = buffer;
      // Download JSON may carry an error, but never constitutes downloadable success.
      if (input.binary && /^\s*\{/.test(buffer.toString("utf8"))) {
        let errorBody: unknown;
        try { errorBody = JSON.parse(buffer.toString("utf8")) as unknown; }
        catch { throw new DeveloperError("invalid_response"); }
        developerApiResult(errorBody);
      }
      if (!input.binary) {
        try { data = JSON.parse(buffer.toString("utf8")) as unknown; }
        catch { throw new DeveloperError("invalid_response"); }
        if (!bundle) developerApiResult(data);
        else if (developerRecord(data) && "resultCode" in data) {
          developerApiResult(data);
          throw new DeveloperError("invalid_response");
        }
      }
      let accepted = false;
      return {
        data, headers: response.headers,
        accept() {
          if (accepted) return;
          accepted = true;
          options.session[developerTransportAccess](path, response.headers.getSetCookie());
        }
      };
    }
  };
}

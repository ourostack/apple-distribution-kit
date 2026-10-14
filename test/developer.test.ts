import { chmodSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as kit from "../src/index.js";

const teamId = "743GT2AJ24";
const secret = "COOKIE_SECRET_MUST_NOT_LEAK";
const key = {
  keyId: "ABC123DE45", keyName: "Example",
  services: [{ id: "APPLE_ID_AUTH_KEY_CONFIGURATION", configurations: [{ primaryAppId: secret }] }],
  canDownload: false, canRevoke: true, privateKey: secret,
  creatorEmail: "PRIVATE_CREATOR_EMAIL", creatorName: "PRIVATE_CREATOR_NAME"
};
const enrollment = (overrides = {}) => ({
  teamId,
  cookies: [{ name: "session", value: secret, domain: ".apple.com", path: "/", secure: true, httpOnly: true, expires: -1 }],
  ...overrides
});
// Each run stays in this worktree; these synthetic credentials never contact Apple.
const root = join(process.cwd(), "node_modules", ".cache", "developer-test-artifacts", `${Date.now()}-${process.pid}`);
mkdirSync(root, { recursive: true, mode: 0o700 });
const inventoryFile = join(root, "inventory.json");
const resources: string[] = [root, inventoryFile];
writeFileSync(inventoryFile, JSON.stringify(resources, null, 2), { mode: 0o600 });
function path(name: string) {
  const result = join(root, name);
  resources.push(result);
  writeFileSync(inventoryFile, JSON.stringify(resources, null, 2), { mode: 0o600 });
  return result;
}
function api() {
  expect(kit).toHaveProperty("createDeveloperClient");
  expect(kit).toHaveProperty("importDeveloperSession");
  expect(kit).toHaveProperty("loadDeveloperSession");
  return kit as any;
}
function session(input = enrollment()) {
  return api().importDeveloperSession({ teamId, input, sessionFile: path(`session-${resources.length}.json`) });
}
const response = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function client(fetch: typeof globalThis.fetch, input = enrollment()) {
  return api().createDeveloperClient({ teamId, session: session(input), fetch });
}

describe("Developer read-only transport", () => {
  it("uses only pinned read paths, scoped forms and sanitized summaries", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const c = client(async (url, init) => {
      seen.push({ url: String(url), init: init! });
      return response({ resultCode: 0, keys: [key] });
    });
    expect(await c.status()).toEqual({ ready: true, teamId });
    expect(await c.keys.get("ABC123DE45")).toEqual({
      keyId: "ABC123DE45", keyName: "Example", serviceIds: ["APPLE_ID_AUTH_KEY_CONFIGURATION"], canDownload: false, canRevoke: true
    });
    expect(seen.map(x => x.url)).toEqual([
      "https://developer.apple.com/services-account/QH65B2/account/auth/key/list",
      "https://developer.apple.com/services-account/QH65B2/account/auth/key/get"
    ]);
    expect(String(seen[0]!.init.body)).toBe("teamId=743GT2AJ24&pageNumber=1&pageSize=50&sort=name%3Dasc");
    expect(String(seen[1]!.init.body)).toBe("teamId=743GT2AJ24&keyId=ABC123DE45");
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.redirect).toBe("manual");
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [response({ resultCode: 7, resultString: secret }), "apple_error", false],
    [response({ keys: [] }), "invalid_response", false],
    [response({ resultCode: "0", keys: [] }), "invalid_response", false],
    [response({ resultCode: null, keys: [] }), "invalid_response", false],
    [response({ resultCode: 0, keys: [] }, 401), "sign_in_required", true],
    [response({ resultCode: 0, keys: [] }, 403), "permission_denied", false],
    [response({ resultCode: 0, keys: [] }, 500), "http_error", false],
    [new Response(`<html>${secret}</html>`, { headers: { "content-type": "text/html" } }), "sign_in_required", true],
    [new Response("", { status: 302, headers: { location: "https://idmsa.apple.com/login" } }), "sign_in_required", true],
    [new Response("", { status: 302, headers: { location: `https://evil.test/${secret}` } }), "redirect_rejected", false],
    [response({ resultCode: 0, keys: null }), "invalid_response", false],
    [response({ resultCode: 0, keys: [{ ...key, services: [{ id: {} }] }] }), "invalid_response", false],
    [response({ resultCode: 0, keys: [{ ...key, canDownload: "yes" }] }), "invalid_response", false],
    [new Response(secret, { headers: { "content-type": "application/json" } }), "invalid_response", false]
  ])("sanitizes errors %# and preserves explicit human outcomes", async (r, code, human) => {
    const c = client(async () => r);
    const error = await c.status().catch((e: any) => e);
    expect(error.code).toBe(code);
    expect(Boolean(error.requiresHuman)).toBe(human);
    if (human) expect(error.requiresHuman.type).toBe("requiresHuman");
    expect(JSON.stringify(error) + error.message + error.stack).not.toContain(secret);
  });

  it("sanitizes network failures", async () => {
    await expect(client(async () => { throw new Error(secret); }).status()).rejects.toMatchObject({ code: "network_error" });
  });

  it("rejects wrong-ID and multiple-key get results", async () => {
    for (const keys of [[{ ...key, keyId: "ZZZ123DE45" }], [key, key], []]) {
      await expect(client(async () => response({ resultCode: 0, keys })).keys.get("ABC123DE45")).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("rejects invalid key and team syntax before transport", async () => {
    const c = client(async () => { throw new Error("must not fetch"); });
    await expect(c.keys.get("../../create")).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(() => api().createDeveloperClient({ teamId: "https://evil.test", session: session() })).toThrow();
  });

  it("rejects credential headers for arbitrary hosts and unsupported paths", () => {
    const s = session();
    for (const target of ["https://evil.test/", "../create", "account/auth/key/create", "account/auth/key/list?x=1"]) {
      expect(() => s.cookieHeader(target)).toThrow();
      expect(() => s.refresh(target, ["session=BAD; Secure; Path=/"])).toThrow();
    }
  });

  it("rejects a redirect-following injected transport", async () => {
    const r = response({ resultCode: 0, keys: [] });
    Object.defineProperty(r, "redirected", { value: true });
    Object.defineProperty(r, "url", { value: "https://evil.test/" });
    await expect(client(async () => r).status()).rejects.toMatchObject({ code: "redirect_rejected" });
  });

  it("does not guess agreement or 2FA gates from unknown Apple errors", async () => {
    await expect(client(async () => response({ resultCode: 999999, resultString: `Agreement / 2FA ${secret}` })).status()).rejects.toMatchObject({ code: "apple_error" });
  });

  it("paginates full pages then stops on a short page", async () => {
    const c = client(async (_url, init) => {
      const page = new URLSearchParams(String(init!.body)).get("pageNumber");
      return response({ resultCode: 0, keys: page === "1" ? Array.from({ length: 50 }, (_, i) => ({ ...key, keyId: `A${String(i).padStart(9, "0")}` })) : [key] });
    });
    expect(await c.keys.list()).toHaveLength(51);
  });

  it("rejects repeated pages instead of returning partial results", async () => {
    const keys = Array.from({ length: 50 }, (_, i) => ({ ...key, keyId: `A${String(i).padStart(9, "0")}` }));
    await expect(client(async () => response({ resultCode: 0, keys })).keys.list()).rejects.toMatchObject({ code: "pagination_non_progress" });
  });

  it("rejects a full page at the 100-page cap without partial success", async () => {
    let calls = 0;
    const c = client(async () => {
      calls++;
      return response({ resultCode: 0, keys: Array.from({ length: 50 }, (_, i) => ({ ...key, keyId: `A${String(calls * 50 + i).padStart(9, "0")}` })) });
    });
    await expect(c.keys.list()).rejects.toMatchObject({ code: "pagination_limit" });
    expect(calls).toBe(100);
  });
});

describe("private Developer enrollment and refresh", () => {
  it("records exact resource paths durably while the worker is running", () => {
    const planned = path("recorded-probe.json");
    expect(JSON.parse(readFileSync(join(root, "inventory.json"), "utf8"))).toContain(planned);
  });
  it("writes owner-only credentials and loads them with explicit team binding", async () => {
    const file = path("private.json");
    api().importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const loaded = api().loadDeveloperSession({ teamId, sessionFile: file });
    expect(await api().createDeveloperClient({ teamId, session: loaded, fetch: async () => response({ resultCode: 0, keys: [] }) }).status()).toEqual({ ready: true, teamId });
    expect(() => api().loadDeveloperSession({ teamId: "ZZZZZZZZZZ", sessionFile: file })).toThrow();
    expect(() => api().importDeveloperSession({ teamId, input: enrollment(), sessionFile: file })).toThrow();
    expect(readFileSync(file, "utf8")).toContain(secret);
  });

  it("rejects permissive files, symlinks and permissive parent stores", () => {
    const file = path("unsafe.json");
    writeFileSync(file, JSON.stringify(enrollment()), { mode: 0o644 });
    expect(() => api().loadDeveloperSession({ teamId, sessionFile: file })).toThrow();
    const link = path("link.json");
    symlinkSync(file, link);
    expect(() => api().loadDeveloperSession({ teamId, sessionFile: link })).toThrow();
    expect(() => api().importDeveloperSession({ teamId, input: enrollment(), sessionFile: link })).toThrow();
    const dir = path("public");
    mkdirSync(dir, { mode: 0o755 });
    expect(() => api().importDeveloperSession({ teamId, input: enrollment(), sessionFile: join(dir, "session.json") })).toThrow();
    chmodSync(file, 0o600);
  });

  it("rejects hardlinked credential files and foreign ownership", () => {
    const file = path("hardlink-original.json");
    api().importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    const alias = path("hardlink-alias.json");
    linkSync(file, alias);
    expect(() => api().loadDeveloperSession({ teamId, sessionFile: file })).toThrow();
    const owned = path("foreign-owner.json");
    api().importDeveloperSession({ teamId, input: enrollment(), sessionFile: owned });
    const uid = vi.spyOn(process, "getuid").mockReturnValue(statSync(owned).uid + 1);
    try { expect(() => api().loadDeveloperSession({ teamId, sessionFile: owned })).toThrow(); }
    finally { uid.mockRestore(); }
  });

  it("rejects a symlink parent and leaves an unrelated existing file intact", () => {
    const target = path("symlink-parent");
    mkdirSync(target, { mode: 0o700 });
    const alias = path("parent-alias");
    symlinkSync(target, alias);
    expect(() => api().importDeveloperSession({ teamId, input: enrollment(), sessionFile: join(alias, "session.json") })).toThrow();
    const file = path("unrelated.txt");
    writeFileSync(file, "DO NOT TRUNCATE", { mode: 0o600 });
    expect(() => api().importDeveloperSession({ teamId, input: enrollment(), sessionFile: file })).toThrow();
    expect(readFileSync(file, "utf8")).toBe("DO NOT TRUNCATE");
  });

  it("rejects out-of-scope cookie domains and paths in a tampered stored jar", () => {
    for (const changes of [{ domain: "evil.test" }, { path: "/elsewhere" }, { secure: false }]) {
      const file = path(`tamper-${resources.length}.json`);
      api().importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
      const stored = JSON.parse(readFileSync(file, "utf8"));
      Object.assign(stored.jar.cookies[0], changes);
      writeFileSync(file, JSON.stringify(stored));
      expect(() => api().loadDeveloperSession({ teamId, sessionFile: file })).toThrow();
    }
  });

  it("does not serialize a session's cookies through JSON", () => {
    expect(JSON.stringify(session())).not.toContain(secret);
  });

  it.each([
    { teamId: "ZZZZZZZZZZ" },
    { cookies: [{ ...enrollment().cookies[0], domain: "evil.test" }] },
    { cookies: [{ ...enrollment().cookies[0], path: "/other" }] },
    { cookies: [{ ...enrollment().cookies[0], secure: false }] },
    { cookies: [{ ...enrollment().cookies[0], expires: 1 }] },
    { cookies: [{ ...enrollment().cookies[0], name: "bad\r\nname" }] },
    { cookies: [] }
  ])("rejects ineligible enrollment %# before writing", overrides => {
    const file = path(`invalid-${resources.length}.json`);
    expect(() => api().importDeveloperSession({ teamId, input: enrollment(overrides), sessionFile: file })).toThrow();
    expect(() => statSync(file)).toThrow();
  });

  it("persists eligible Set-Cookie refresh through the maintained jar", async () => {
    const file = path("refresh.json");
    const s = api().importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    const c = api().createDeveloperClient({ teamId, session: s, fetch: async () => response({ resultCode: 0, keys: [] }, 200, { "set-cookie": "session=REFRESHED; Domain=.apple.com; Path=/; Secure; HttpOnly" }) });
    await c.status();
    const loaded = api().loadDeveloperSession({ teamId, sessionFile: file });
    const next = api().createDeveloperClient({ teamId, session: loaded, fetch: async (_u: unknown, init: RequestInit) => {
      expect(new Headers(init.headers).get("cookie")).toContain("session=REFRESHED");
      expect(new Headers(init.headers).get("cookie")).not.toContain(secret);
      return response({ resultCode: 0, keys: [] });
    } });
    await next.status();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("marks an expired jar as requiring human sign-in without fetching", async () => {
    const s = session();
    const c = api().createDeveloperClient({ teamId, session: s, fetch: async () => response({ resultCode: 0, keys: [] }, 200, { "set-cookie": "session=gone; Domain=.apple.com; Max-Age=0; Path=/; Secure" }) });
    await c.status();
    await expect(c.status()).rejects.toMatchObject({ code: "session_expired", requiresHuman: { type: "requiresHuman" } });
  });

  it.each([
    "other=BAD; Domain=evil.test; Secure; Path=/",
    "other=BAD; Secure; Path=/elsewhere",
    "other=BAD; Path=/",
    "not a cookie"
  ])("rejects unsafe refresh %# without persisting it", async value => {
    const file = path(`bad-refresh-${resources.length}.json`);
    const s = api().importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    const before = readFileSync(file, "utf8");
    const c = api().createDeveloperClient({ teamId, session: s, fetch: async () => response({ resultCode: 0, keys: [] }, 200, { "set-cookie": value }) });
    await expect(c.status()).rejects.toMatchObject({ code: "invalid_response" });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("does not overwrite a credential file changed after loading", async () => {
    const file = path("changed.json");
    const s = api().importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    writeFileSync(file, '{"unrelated":true}');
    const c = api().createDeveloperClient({ teamId, session: s, fetch: async () => response({ resultCode: 0, keys: [] }, 200, { "set-cookie": "session=NEW; Secure; Path=/" }) });
    await expect(c.status()).rejects.toMatchObject({ code: "unsafe_session_store" });
    expect(readFileSync(file, "utf8")).toBe('{"unrelated":true}');
  });
});

describe("Developer CLI", () => {
  it.each([
    ["developer", "status"],
    ["developer", "status", "--team-id"],
    ["developer", "status", "--team-id", teamId, "--team-id", teamId],
    ["developer", "status", "--team-id", teamId, "--cookie", secret],
    ["developer", "keys", "get", "--team-id", teamId, "--key-id", "../get"],
    ["developer", "keys", "get", "--team-id", teamId],
    ["developer", "keys", "list", "--team-id", teamId, "extra"],
    ["developer", "session", "import", "--team-id", teamId, "--input"],
    ["developer", "status", "--team-id", teamId, "--json", "--json"],
    ["developer", "status", "--team-id", teamId, "--help", secret]
  ])("rejects malformed options without echoing input %#", async args => {
    let output = "";
    const cli = kit.createCli({ stdout: x => { output += x; }, stderr: x => { output += x; } });
    expect(await cli([...args, ...(args.includes("--json") ? [] : ["--json"])])).toBe(64);
    expect(JSON.parse(output).ok).toBe(false);
    expect(output).not.toContain(secret);
  });

  it("imports a private file and runs nested commands using normal JSON envelopes", async () => {
    const input = path("input.json");
    writeFileSync(input, JSON.stringify(enrollment()), { mode: 0o600 });
    const file = path("cli-session.json");
    let output = "";
    const cli = kit.createCli({ stdout: x => { output += x; }, stderr: x => { output += x; } }, {
      developer: { fetch: async () => response({ resultCode: 0, keys: [key] }) }
    } as any);
    expect(await cli(["developer", "session", "import", "--team-id", teamId, "--session-file", file, "--input", input, "--json"])).toBe(0);
    expect(JSON.parse(output).ok).toBe(true);
    output = "";
    expect(await cli(["developer", "keys", "get", "--team-id", teamId, "--session-file", file, "--key-id", key.keyId, "--json"])).toBe(0);
    expect(JSON.parse(output).result.keyId).toBe(key.keyId);
    expect(output).not.toContain(secret);
    output = "";
    expect(await cli(["--version"])).toBe(0);
    expect(output).toContain("0.1.0");
  });

  it("never echoes server, cookie or exception secrets at a human gate", async () => {
    const file = path("cli-error.json");
    api().importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    let output = "";
    const cli = kit.createCli({ stdout: x => { output += x; }, stderr: x => { output += x; } }, {
      developer: { fetch: async () => new Response(secret, { status: 401 }) }
    } as any);
    expect(await cli(["developer", "status", "--team-id", teamId, "--session-file", file, "--json"])).toBe(69);
    expect(JSON.parse(output).error.requiresHuman.type).toBe("requiresHuman");
    expect(output).not.toContain(secret);
  });

  it("imports stdin without credential-bearing options or transport", async () => {
    const file = path("stdin.json");
    let output = "";
    const cli = kit.createCli({ stdout: x => { output += x; }, stderr: x => { output += x; } }, {
      developer: { readStdin: () => JSON.stringify(enrollment()), fetch: async () => { throw new Error("must not fetch"); } }
    } as any);
    expect(await cli(["developer", "session", "import", "--team-id", teamId, "--session-file", file, "--input", "-", "--json"])).toBe(0);
    expect(output).not.toContain(secret);
  });

  it("preserves the existing leading --json convention without hiding duplicates", async () => {
    const file = path("leading-json.json");
    api().importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    let output = "";
    const cli = kit.createCli({ stdout: x => { output += x; }, stderr: x => { output += x; } }, {
      developer: { fetch: async () => response({ resultCode: 0, keys: [] }) }
    } as any);
    expect(await cli(["--json", "developer", "status", "--team-id", teamId, "--session-file", file])).toBe(0);
    expect(JSON.parse(output).result.ready).toBe(true);
    output = "";
    expect(await cli(["--json", "developer", "status", "--team-id", teamId, "--session-file", file, "--json"])).toBe(64);
    expect(JSON.parse(output).error.code).toBe("invalid_arguments");
  });

  it.each([false, true])("sanitizes exception, key payload and CSRF values in CLI errors (json=%s)", async json => {
    const file = path(`cli-network-${json}.json`);
    api().importDeveloperSession({ teamId, input: enrollment({ cookies: [...enrollment().cookies, { ...enrollment().cookies[0], name: "csrf", value: "CSRF_SECRET_MUST_NOT_LEAK" }] }), sessionFile: file });
    let output = "";
    const cli = kit.createCli({ stdout: x => { output += x; }, stderr: x => { output += x; } }, {
      developer: { fetch: async () => { throw new Error(`${secret} CSRF_SECRET_MUST_NOT_LEAK PRIVATE_KEY_VALUE`); } }
    } as any);
    expect(await cli(["developer", "status", "--team-id", teamId, "--session-file", file, ...(json ? ["--json"] : [])])).toBe(69);
    expect(output).not.toMatch(/COOKIE_SECRET|CSRF_SECRET|PRIVATE_KEY_VALUE/);
  });
});

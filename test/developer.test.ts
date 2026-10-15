import fs, { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { CookieJar } from "tough-cookie";
import { DeveloperError, type CliDependencies, type DeveloperClient, type DeveloperEnrollment, type DeveloperErrorCode, type DeveloperSession } from "../src/index.js";
import * as kit from "../src/index.js";

const teamId = "743GT2AJ24";
const secret = "COOKIE_SECRET_MUST_NOT_LEAK";
const key = {
  keyId: "ABC123DE45", keyName: "Example",
  services: [{ id: "APPLE_ID_AUTH_KEY_CONFIGURATION", configurations: [{ primaryAppId: secret }] }],
  canDownload: false, canRevoke: true, privateKey: secret,
  creatorEmail: "PRIVATE_CREATOR_EMAIL", creatorName: "PRIVATE_CREATOR_NAME"
};
const enrollment = (overrides: Partial<DeveloperEnrollment> = {}): DeveloperEnrollment => ({
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
function session(input: unknown = enrollment()): DeveloperSession {
  return kit.importDeveloperSession({ teamId, input, sessionFile: path(`session-${resources.length}.json`) });
}
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function client(fetch: typeof globalThis.fetch, input: unknown = enrollment()): DeveloperClient {
  return kit.createDeveloperClient({ teamId, session: session(input), fetch });
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
  ] satisfies [Response, DeveloperErrorCode, boolean][])("sanitizes errors %# and preserves explicit human outcomes", async (r, code, human) => {
    const c = client(async () => r);
    const error: unknown = await c.status().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeveloperError);
    if (!(error instanceof DeveloperError)) throw new Error("Expected DeveloperError");
    expect(error.code).toBe(code);
    expect(Boolean(error.requiresHuman)).toBe(human);
    if (human) expect(error.requiresHuman?.type).toBe("requiresHuman");
    expect(JSON.stringify(error) + error.message + error.stack).not.toContain(secret);
  });

  it("sanitizes network failures", async () => {
    await expect(client(async () => { throw new Error(secret); }).status()).rejects.toMatchObject({ code: "network_error" });
  });

  it("rejects wrong-ID and multiple-key get results", async () => {
    for (const keys of [[{ ...key, keyId: "ZZZ123DE45" }], [key, key], []]) {
      const file = path(`exact-key-refresh-${resources.length}.json`);
      const s = kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
      const before = readFileSync(file, "utf8");
      const c = kit.createDeveloperClient({ teamId, session: s, fetch: async () => response(
        { resultCode: 0, keys }, 200, { "set-cookie": "session=UNVALIDATED; Secure; Path=/" }
      ) });
      await expect(c.keys.get("ABC123DE45")).rejects.toMatchObject({ code: "invalid_response" });
      expect(readFileSync(file, "utf8")).toBe(before);
    }
  });

  it("accepts eligible response cookies after exact-key identity validation", async () => {
    const file = path("valid-exact-key-refresh.json");
    const s = kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    const c = kit.createDeveloperClient({ teamId, session: s, fetch: async () => response(
      { resultCode: 0, keys: [key] }, 200, { "set-cookie": "session=VERIFIED; Secure; Path=/" }
    ) });
    expect(await c.keys.get(key.keyId)).toMatchObject({ keyId: key.keyId });
    expect(kit.loadDeveloperSession({ teamId, sessionFile: file }).cookieHeader("account/auth/key/get")).toContain("session=VERIFIED");
  });

  it("rejects invalid key and team syntax before transport", async () => {
    const c = client(async () => { throw new Error("must not fetch"); });
    await expect(c.keys.get("../../create")).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(() => kit.createDeveloperClient({ teamId: "https://evil.test", session: session() })).toThrow();
  });

  it("rejects credential headers for arbitrary hosts and unsupported paths", () => {
    const s = session();
    for (const target of ["https://evil.test/", "../create", "account/auth/key/create", "account/auth/key/list?x=1"]) {
      expect(() => Reflect.apply(s.cookieHeader, s, [target])).toThrow();
      expect(() => Reflect.apply(s.refresh, s, [target, ["session=BAD; Secure; Path=/"]])).toThrow();
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

  it("maps only the verified numeric agreement code to a manual native human gate", async () => {
    const c = client(async () => response({ resultCode: 2100, resultString: secret, keys: [] }));
    await expect(c.status()).rejects.toMatchObject({
      code: "agreement_required",
      requiresHuman: {
        type: "requiresHuman",
        code: "developer_agreement_required",
        url: "https://developer.apple.com/register/agree/"
      }
    });
    for (const code of [2099, 2101, "2100"]) {
      await expect(client(async () => response({ resultCode: code, resultString: `agree ${secret}` })).status())
        .rejects.toMatchObject({ code: typeof code === "number" ? "apple_error" : "invalid_response" });
    }
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
  it("refuses Windows credentials before any file, stdin or credential-header I/O", async () => {
    const file = path("platform-existing.json");
    const s = kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    const destination = path("windows-must-not-exist.json");
    const before = readFileSync(file, "utf8");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    let ioAttempted = false;
    const refuseIo = () => { ioAttempted = true; throw new Error("credential I/O must not run"); };
    const checks = [
      vi.spyOn(fs, "readFileSync").mockImplementation(refuseIo),
      vi.spyOn(fs, "openSync").mockImplementation(refuseIo),
      vi.spyOn(fs, "lstatSync").mockImplementation(refuseIo)
    ];
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(() => kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: destination })).toThrowError(expect.objectContaining({ code: "unsupported_platform" }));
      expect(() => kit.loadDeveloperSession({ teamId, sessionFile: file })).toThrowError(expect.objectContaining({ code: "unsupported_platform" }));
      expect(() => s.refresh("account/auth/key/list", ["session=NEW; Secure; Path=/"])).toThrowError(expect.objectContaining({ code: "unsupported_platform" }));
      expect(() => s.cookieHeader("account/auth/key/list")).toThrowError(expect.objectContaining({ code: "unsupported_platform" }));
      let output = "";
      const cli = kit.createCli({ stdout: chunk => { output += chunk; }, stderr: chunk => { output += chunk; } }, {
        developer: { readStdin: refuseIo }
      } satisfies CliDependencies);
      for (const input of [file, "-"]) {
        output = "";
        expect(await cli(["developer", "session", "import", "--team-id", teamId, "--session-file", destination, "--input", input, "--json"])).toBe(69);
        expect(JSON.parse(output).error.code).toBe("unsupported_platform");
      }
      expect(ioAttempted).toBe(false);
      checks.forEach(check => check.mockRestore());
      syncBuiltinESMExports();
      output = "";
      expect(await cli(["--version"])).toBe(0);
      expect(output).toContain("0.1.0");
    } finally {
      Object.defineProperty(process, "platform", platform);
      checks.forEach(check => check.mockRestore());
      syncBuiltinESMExports();
    }
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(`${file}.refresh.lock`)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("records exact resource paths durably while the worker is running", () => {
    const planned = path("recorded-probe.json");
    expect(JSON.parse(readFileSync(join(root, "inventory.json"), "utf8"))).toContain(planned);
  });
  it("writes owner-only credentials and loads them with explicit team binding", async () => {
    const file = path("private.json");
    kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const loaded = kit.loadDeveloperSession({ teamId, sessionFile: file });
    expect(await kit.createDeveloperClient({ teamId, session: loaded, fetch: async () => response({ resultCode: 0, keys: [] }) }).status()).toEqual({ ready: true, teamId });
    expect(() => kit.loadDeveloperSession({ teamId: "ZZZZZZZZZZ", sessionFile: file })).toThrow();
    expect(() => kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file })).toThrow();
    expect(readFileSync(file, "utf8")).toContain(secret);
  });

  it("rejects permissive files, symlinks and permissive parent stores", () => {
    const file = path("unsafe.json");
    writeFileSync(file, JSON.stringify(enrollment()), { mode: 0o644 });
    expect(() => kit.loadDeveloperSession({ teamId, sessionFile: file })).toThrow();
    const link = path("link.json");
    symlinkSync(file, link);
    expect(() => kit.loadDeveloperSession({ teamId, sessionFile: link })).toThrow();
    expect(() => kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: link })).toThrow();
    const dir = path("public");
    mkdirSync(dir, { mode: 0o755 });
    expect(() => kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: join(dir, "session.json") })).toThrow();
    chmodSync(file, 0o600);
  });

  it("rejects hardlinked credential files and foreign ownership", () => {
    const file = path("hardlink-original.json");
    kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    const alias = path("hardlink-alias.json");
    linkSync(file, alias);
    expect(() => kit.loadDeveloperSession({ teamId, sessionFile: file })).toThrow();
    const owned = path("foreign-owner.json");
    kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: owned });
    const uid = vi.spyOn(process, "getuid").mockReturnValue(statSync(owned).uid + 1);
    try { expect(() => kit.loadDeveloperSession({ teamId, sessionFile: owned })).toThrow(); }
    finally { uid.mockRestore(); }
  });

  it("rejects a symlink parent and leaves an unrelated existing file intact", () => {
    const target = path("symlink-parent");
    mkdirSync(target, { mode: 0o700 });
    const alias = path("parent-alias");
    symlinkSync(target, alias);
    expect(() => kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: join(alias, "session.json") })).toThrow();
    const file = path("unrelated.txt");
    writeFileSync(file, "DO NOT TRUNCATE", { mode: 0o600 });
    expect(() => kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file })).toThrow();
    expect(readFileSync(file, "utf8")).toBe("DO NOT TRUNCATE");
  });

  it("rejects out-of-scope cookie domains and paths in a tampered stored jar", () => {
    for (const changes of [{ domain: "evil.test" }, { path: "/elsewhere" }, { secure: false }]) {
      const file = path(`tamper-${resources.length}.json`);
      kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
      const stored: { jar: { cookies: Record<string, unknown>[] } } = JSON.parse(readFileSync(file, "utf8"));
      Object.assign(stored.jar.cookies[0]!, changes);
      writeFileSync(file, JSON.stringify(stored));
      expect(() => kit.loadDeveloperSession({ teamId, sessionFile: file })).toThrow();
    }
  });

  it.each([false, true])("SDK-R1 rejects discarded raw cookie rows before library/CLI fetch (valid survivor: %s)", async survivor => {
    const file = path(`discarded-cookie-${survivor}.json`);
    kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored.jar.cookies = [...(survivor ? stored.jar.cookies : []), null];
    writeFileSync(file, JSON.stringify(stored));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ resultCode: 0, keys: [] }));
    let error: unknown;
    try {
      await kit.createDeveloperClient({ teamId, session: kit.loadDeveloperSession({ teamId, sessionFile: file }), fetch }).status();
    } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "invalid_session" });
    expect((error as DeveloperError).requiresHuman).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(secret);
    let output = "";
    const cli = kit.createCli({ stdout: v => { output += v; }, stderr: v => { output += v; } }, { developer: { fetch } });
    expect(await cli(["developer", "status", "--team-id", teamId, "--session-file", file, "--json"])).toBe(69);
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: "invalid_session" } });
    expect(output).not.toMatch(/requiresHuman|COOKIE_SECRET/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["missing-array", "object-array", "string-row", "lossy-value", "lossy-httpOnly", "lossy-date", "unknown-field"])(
    "SDK-R1 refuses malformed serialized cookie structure %s before normalization", kind => {
      const file = path(`raw-cookie-${kind}.json`);
      kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
      const stored = JSON.parse(readFileSync(file, "utf8"));
      if (kind === "missing-array") delete stored.jar.cookies;
      if (kind === "object-array") stored.jar.cookies = {};
      if (kind === "string-row") stored.jar.cookies = [JSON.stringify(stored.jar.cookies[0])];
      if (kind === "lossy-value") stored.jar.cookies[0].value = 123;
      if (kind === "lossy-httpOnly") stored.jar.cookies[0].httpOnly = "true";
      if (kind === "lossy-date") stored.jar.cookies[0].expires = "invalid-date";
      if (kind === "unknown-field") stored.jar.cookies[0].unexpected = secret;
      writeFileSync(file, JSON.stringify(stored));
      expect(() => kit.loadDeveloperSession({ teamId, sessionFile: file }))
        .toThrowError(expect.objectContaining({ code: "invalid_session", requiresHuman: undefined }));
    }
  );

  it("does not serialize a session's cookies through JSON", () => {
    expect(JSON.stringify(session())).not.toContain(secret);
  });

  it.each([
    { teamId: "ZZZZZZZZZZ" },
    { cookies: [{ ...enrollment().cookies[0]!, domain: "evil.test" }] },
    { cookies: [{ ...enrollment().cookies[0]!, path: "/other" }] },
    { cookies: [{ ...enrollment().cookies[0]!, secure: false }] },
    { cookies: [{ ...enrollment().cookies[0]!, expires: 1 }] },
    { cookies: [{ ...enrollment().cookies[0]!, name: "bad\r\nname" }] },
    { cookies: [] }
  ])("rejects ineligible enrollment %# before writing", overrides => {
    const file = path(`invalid-${resources.length}.json`);
    expect(() => kit.importDeveloperSession({ teamId, input: enrollment(overrides), sessionFile: file })).toThrow();
    expect(() => statSync(file)).toThrow();
  });

  it("persists eligible Set-Cookie refresh through the maintained jar", async () => {
    const file = path("refresh.json");
    const s = kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    const c = kit.createDeveloperClient({ teamId, session: s, fetch: async () => response({ resultCode: 0, keys: [] }, 200, { "set-cookie": "session=REFRESHED; Domain=.apple.com; Path=/; Secure; HttpOnly" }) });
    await c.status();
    const loaded = kit.loadDeveloperSession({ teamId, sessionFile: file });
    const next = kit.createDeveloperClient({ teamId, session: loaded, fetch: async (_url, init) => {
      expect(new Headers(init!.headers).get("cookie")).toContain("session=REFRESHED");
      expect(new Headers(init!.headers).get("cookie")).not.toContain(secret);
      return response({ resultCode: 0, keys: [] });
    } });
    await next.status();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("marks an expired jar as requiring human sign-in without fetching", async () => {
    const s = session();
    const c = kit.createDeveloperClient({ teamId, session: s, fetch: async () => response({ resultCode: 0, keys: [] }, 200, { "set-cookie": "session=gone; Domain=.apple.com; Max-Age=0; Path=/; Secure" }) });
    await c.status();
    await expect(c.status()).rejects.toMatchObject({ code: "session_expired", requiresHuman: { type: "requiresHuman" } });
  });

  it.each(["secure-deletion", "empty-after-deletion", "actual-expiration"])("SDK-R1 preserves genuine stored %s sign-in gates", async kind => {
    const file = path(`genuine-expired-${kind}.json`);
    const s = kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    if (kind !== "actual-expiration") {
      await kit.createDeveloperClient({ teamId, session: s, fetch: async () => response(
        { resultCode: 0, keys: [] }, 200, { "set-cookie": "session=gone; Domain=.apple.com; Max-Age=0; Path=/; Secure" }
      ) }).status();
      if (kind === "empty-after-deletion") {
        const stored = JSON.parse(readFileSync(file, "utf8"));
        const jar = CookieJar.deserializeSync(stored.jar);
        expect(jar.getCookieStringSync("https://developer.apple.com/services-account/QH65B2/")).toBe("");
        stored.jar = jar.serializeSync();
        expect(stored.jar.cookies).toEqual([]);
        writeFileSync(file, JSON.stringify(stored));
      }
    } else {
      const stored = JSON.parse(readFileSync(file, "utf8"));
      stored.jar.cookies[0].expires = new Date(0).toISOString();
      writeFileSync(file, JSON.stringify(stored));
    }
    const fetch = vi.fn<typeof globalThis.fetch>();
    const loaded = kit.loadDeveloperSession({ teamId, sessionFile: file });
    await expect(kit.createDeveloperClient({ teamId, session: loaded, fetch }).status())
      .rejects.toMatchObject({ code: "session_expired", requiresHuman: { type: "requiresHuman" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "other=BAD; Domain=evil.test; Secure; Path=/",
    "other=BAD; Secure; Path=/elsewhere",
    "other=BAD; Path=/",
    "not a cookie"
  ])("rejects unsafe refresh %# without persisting it", async value => {
    const file = path(`bad-refresh-${resources.length}.json`);
    const s = kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    const before = readFileSync(file, "utf8");
    const c = kit.createDeveloperClient({ teamId, session: s, fetch: async () => response({ resultCode: 0, keys: [] }, 200, { "set-cookie": value }) });
    await expect(c.status()).rejects.toMatchObject({ code: "invalid_response" });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("does not overwrite a credential file changed after loading", async () => {
    const file = path("changed.json");
    const s = kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    writeFileSync(file, '{"unrelated":true}');
    const c = kit.createDeveloperClient({ teamId, session: s, fetch: async () => response({ resultCode: 0, keys: [] }, 200, { "set-cookie": "session=NEW; Secure; Path=/" }) });
    await expect(c.status()).rejects.toMatchObject({ code: "unsafe_session_store" });
    expect(readFileSync(file, "utf8")).toBe('{"unrelated":true}');
    expect(existsSync(`${file}.refresh.lock`)).toBe(false);
  });

  it("does not persist response cookies before validating the inspection key schema", async () => {
    const file = path("invalid-schema-refresh.json");
    const s = kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    const original = readFileSync(file, "utf8");
    const c = kit.createDeveloperClient({ teamId, session: s, fetch: async () => response({
      resultCode: 0, keys: [{ ...key, keyId: "invalid" }]
    }, 200, { "set-cookie": "session=UNVALIDATED; Secure; Path=/" }) });
    await expect(c.status()).rejects.toMatchObject({ code: "invalid_response" });
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it.each(["regular", "symlink"])("fails closed for another owner's or stale %s lock without removing it", async kind => {
    const file = path(`contended-${kind}.json`);
    const s = kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    const lock = path(`contended-${kind}.json.refresh.lock`);
    if (kind === "regular") {
      writeFileSync(lock, "ANOTHER_OWNER", { mode: 0o600 });
      utimesSync(lock, 0, 0);
    } else {
      const target = path("another-owner-lock");
      writeFileSync(target, "ANOTHER_OWNER", { mode: 0o600 });
      symlinkSync(target, lock);
    }
    const before = readFileSync(file, "utf8");
    const c = kit.createDeveloperClient({ teamId, session: s, fetch: async () => response({ resultCode: 0, keys: [] }, 200, { "set-cookie": "session=NEW; Secure; Path=/" }) });
    await expect(c.status()).rejects.toMatchObject({ code: "session_store_busy" });
    expect(readFileSync(lock, "utf8")).toBe("ANOTHER_OWNER");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("releases its acquired lock on failed atomic publication and permits a retry", async () => {
    const file = path("publication-failure.json");
    const s = kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    const lock = path("publication-failure.json.refresh.lock");
    const before = readFileSync(file, "utf8");
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === file) throw new Error(secret);
      rename(from, to);
    });
    syncBuiltinESMExports();
    const c = kit.createDeveloperClient({ teamId, session: s, fetch: async () => response({ resultCode: 0, keys: [] }, 200, { "set-cookie": "session=RETRY; Domain=.apple.com; Secure; Path=/" }) });
    try { await expect(c.status()).rejects.toMatchObject({ code: "unsafe_session_store" }); }
    finally { failure.mockRestore(); syncBuiltinESMExports(); }
    expect(existsSync(lock)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
    await c.status();
    expect(existsSync(lock)).toBe(false);
    expect(kit.loadDeveloperSession({ teamId, sessionFile: file }).cookieHeader("account/auth/key/list")).toContain("session=RETRY");
  });

  it("never removes another lock installed at its acquired path", async () => {
    const file = path("replaced-lock.json");
    const s = kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    const lock = path("replaced-lock.json.refresh.lock");
    const displaced = path("displaced-owned-lock");
    const rename = fs.renameSync;
    const replacement = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === file) {
        rename(lock, displaced);
        writeFileSync(lock, "NEW_OWNER", { mode: 0o600 });
      }
      rename(from, to);
    });
    syncBuiltinESMExports();
    const c = kit.createDeveloperClient({ teamId, session: s, fetch: async () => response({ resultCode: 0, keys: [] }, 200, { "set-cookie": "session=NEW; Secure; Path=/" }) });
    try { await expect(c.status()).rejects.toMatchObject({ code: "unsafe_session_store" }); }
    finally { replacement.mockRestore(); syncBuiltinESMExports(); }
    expect(readFileSync(lock, "utf8")).toBe("NEW_OWNER");
    expect(existsSync(displaced)).toBe(true);
  });

  it("prevents two normal readers overwriting refreshed jars across processes", async () => {
    const file = path("interleaved.json");
    kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    const second = kit.loadDeveloperSession({ teamId, sessionFile: file });
    const modulePath = path("developer-session.js");
    const planPath = path("plan.js");
    for (const [source, output] of [["developer-session.ts", modulePath], ["plan.ts", planPath]] as const) {
      writeFileSync(output, transpileModule(readFileSync(join(process.cwd(), "src", source), "utf8"), {
        compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ES2022 }
      }).outputText);
    }
    const proceed = path("allow-first-refresh");
    const lock = path("interleaved.json.refresh.lock");
    const worker = spawn(process.execPath, ["--input-type=module", "--eval", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const { loadDeveloperSession } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
      const session = loadDeveloperSession({ teamId: ${JSON.stringify(teamId)}, sessionFile: ${JSON.stringify(file)} });
      const read = fs.readFileSync;
      fs.readFileSync = function (...args) {
        const data = read.apply(this, args);
        if (typeof args[0] === "number") {
          process.send("snapshot-read");
          const deadline = Date.now() + 5000;
          while (!fs.existsSync(${JSON.stringify(proceed)})) {
            if (Date.now() >= deadline) throw new Error("test barrier timed out");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return data;
      };
      syncBuiltinESMExports();
      session.refresh("account/auth/key/list", ["first=FIRST_REFRESH; Secure; Path=/"]);
    `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    worker.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const finished = new Promise<number | null>(resolve => worker.once("close", resolve));
    const ready = new Promise<void>((resolve, reject) => {
      worker.once("message", message => message === "snapshot-read" ? resolve() : reject(new Error("unexpected worker message")));
      worker.once("error", reject);
      worker.once("close", () => reject(new Error("worker ended before barrier")));
    });
    try {
      await ready;
      const c = kit.createDeveloperClient({ teamId, session: second, fetch: async () => response({ resultCode: 0, keys: [] }, 200, { "set-cookie": "second=SECOND_REFRESH; Secure; Path=/" }) });
      await expect(c.status()).rejects.toMatchObject({ code: "session_store_busy" });
      expect(statSync(lock).mode & 0o777).toBe(0o600);
    } finally {
      writeFileSync(proceed, "continue", { mode: 0o600 });
      expect(await finished, stderr).toBe(0);
    }
    const saved = kit.loadDeveloperSession({ teamId, sessionFile: file });
    expect(saved.cookieHeader("account/auth/key/list")).toContain("first=FIRST_REFRESH");
    expect(saved.cookieHeader("account/auth/key/list")).not.toContain("second=SECOND_REFRESH");
    expect(existsSync(lock)).toBe(false);
  });
});

describe("Developer CLI", () => {
  it("reports the verified agreement gate without raw portal values or accepting terms", async () => {
    const file = path("cli-agreement.json");
    kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    let output = "";
    let calls = 0;
    const cli = kit.createCli({ stdout: chunk => { output += chunk; }, stderr: chunk => { output += chunk; } }, {
      developer: { fetch: async () => { calls++; return response({ resultCode: 2100, resultString: secret }); } }
    } satisfies CliDependencies);
    expect(await cli(["developer", "status", "--team-id", teamId, "--session-file", file, "--json"])).toBe(69);
    expect(JSON.parse(output).error.requiresHuman?.code).toBe("developer_agreement_required");
    expect(output).not.toContain(secret);
    expect(calls).toBe(1);
  });

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
  ])("rejects malformed options without echoing input %#", async (...args) => {
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
    } satisfies CliDependencies);
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
    kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    let output = "";
    const cli = kit.createCli({ stdout: x => { output += x; }, stderr: x => { output += x; } }, {
      developer: { fetch: async () => new Response(secret, { status: 401 }) }
    } satisfies CliDependencies);
    expect(await cli(["developer", "status", "--team-id", teamId, "--session-file", file, "--json"])).toBe(69);
    expect(JSON.parse(output).error.requiresHuman.type).toBe("requiresHuman");
    expect(output).not.toContain(secret);
  });

  it("returns a sanitized nonzero CLI contention error without exposing lock or cookies", async () => {
    const file = path("cli-contention.json");
    kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    const lock = path("cli-contention.json.refresh.lock");
    writeFileSync(lock, secret, { mode: 0o600 });
    let output = "";
    const cli = kit.createCli({ stdout: chunk => { output += chunk; }, stderr: chunk => { output += chunk; } }, {
      developer: { fetch: async () => response({ resultCode: 0, keys: [] }, 200, { "set-cookie": `session=${secret}; Domain=.apple.com; Secure; Path=/` }) }
    } satisfies CliDependencies);
    expect(await cli(["developer", "status", "--team-id", teamId, "--session-file", file, "--json"])).toBe(69);
    expect(JSON.parse(output).error.code).toBe("session_store_busy");
    expect(output).not.toContain(secret);
    expect(readFileSync(lock, "utf8")).toBe(secret);
  });

  it("imports stdin without credential-bearing options or transport", async () => {
    const file = path("stdin.json");
    let output = "";
    const cli = kit.createCli({ stdout: x => { output += x; }, stderr: x => { output += x; } }, {
      developer: { readStdin: () => JSON.stringify(enrollment()), fetch: async () => { throw new Error("must not fetch"); } }
    } satisfies CliDependencies);
    expect(await cli(["developer", "session", "import", "--team-id", teamId, "--session-file", file, "--input", "-", "--json"])).toBe(0);
    expect(output).not.toContain(secret);
  });

  it("preserves the existing leading --json convention without hiding duplicates", async () => {
    const file = path("leading-json.json");
    kit.importDeveloperSession({ teamId, input: enrollment(), sessionFile: file });
    let output = "";
    const cli = kit.createCli({ stdout: x => { output += x; }, stderr: x => { output += x; } }, {
      developer: { fetch: async () => response({ resultCode: 0, keys: [] }) }
    } satisfies CliDependencies);
    expect(await cli(["--json", "developer", "status", "--team-id", teamId, "--session-file", file])).toBe(0);
    expect(JSON.parse(output).result.ready).toBe(true);
    output = "";
    expect(await cli(["--json", "developer", "status", "--team-id", teamId, "--session-file", file, "--json"])).toBe(64);
    expect(JSON.parse(output).error.code).toBe("invalid_arguments");
  });

  it.each([false, true])("sanitizes exception, key payload and CSRF values in CLI errors (json=%s)", async json => {
    const file = path(`cli-network-${json}.json`);
    kit.importDeveloperSession({ teamId, input: enrollment({ cookies: [...enrollment().cookies, { ...enrollment().cookies[0]!, name: "csrf", value: "CSRF_SECRET_MUST_NOT_LEAK" }] }), sessionFile: file });
    let output = "";
    const cli = kit.createCli({ stdout: x => { output += x; }, stderr: x => { output += x; } }, {
      developer: { fetch: async () => { throw new Error(`${secret} CSRF_SECRET_MUST_NOT_LEAK PRIVATE_KEY_VALUE`); } }
    } satisfies CliDependencies);
    expect(await cli(["developer", "status", "--team-id", teamId, "--session-file", file, ...(json ? ["--json"] : [])])).toBe(69);
    expect(output).not.toMatch(/COOKIE_SECRET|CSRF_SECRET|PRIVATE_KEY_VALUE/);
  });
});

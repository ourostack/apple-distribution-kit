import fs from "node:fs";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { CookieJar } from "tough-cookie";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as kit from "../src/index.js";
import { developerCommand } from "../src/developer-cli.js";
import { createDeveloperTransport } from "../src/developer-transport.js";
import {
  acquireDeveloperPrivateLock, developerTransportAccess, developerTransportUrl,
  readDeveloperPrivateInput, writeDeveloperPrivateStore
} from "../src/developer-session.js";

const home = vi.hoisted(() => `${process.cwd()}/node_modules/.cache/developer-coverage-${Date.now()}-${process.pid}`);
vi.mock("node:os", () => ({ homedir: () => home }));
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const inventory = join(home, "resources.json");
const allocated = [home, inventory];
let serial = 0;
const teamId = "COVER12345";
const primaryAppId = "APPS123456";
const identifier = "org.example.coverage";
const secret = "PRIVATE_TEST_DATA_NOT_PUBLIC";
const directory = join(home, ".apple-distribution-kit", "developer-operations", teamId);
function file(label: string) {
  const result = join(home, `${++serial}-${label}`);
  allocated.push(result);
  fs.writeFileSync(inventory, JSON.stringify(allocated), { mode: 0o600 });
  return result;
}
const response = (data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { headers: { "content-type": "application/json", ...headers } });
const enrollment = () => ({ teamId, cookies: [{
  name: "session", value: secret, domain: ".apple.com", path: "/", secure: true, httpOnly: true, expires: -1
}] });
const pem = () => generateKeyPairSync("ec", { namedCurve: "prime256v1",
  publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).privateKey;
function fixture(action: "create" | "revoke" | "download" = "create") {
  const sessionFile = file("session.json");
  const session = kit.importDeveloperSession({ teamId, sessionFile, input: enrollment() });
  const planFile = file("plan.json");
  const output = file("output.p8");
  const key = { keyId: `K${String(serial).padStart(9, "0")}`, keyName: `Coverage ${serial}`, canRevoke: true, canDownload: true,
    services: [{ id: "APPLE_ID_AUTH_KEY_CONFIGURATION", name: "SIWA", relatedKeys: [] as string[],
      configurations: [{ id: primaryAppId, identifier: `${teamId}.${identifier}`, type: "bundle", name: "Example",
        musicKitEnabled: false, shazamKitEnabled: false, musicFeedEnabled: false }] }] };
  let keys = action === "create" ? [] : [key];
  let override: ((url: string, init: RequestInit) => Response | Promise<Response> | undefined) | undefined;
  let attempts = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (/\/(?:create|revoke|download)(?:\?|$)/.test(path)) attempts++;
    const custom = await override?.(path, init!);
    if (custom) return custom;
    if (path.includes("/bundleIds/")) return response({ data: { type: "bundleIds", id: primaryAppId,
      attributes: { identifier, seedId: teamId } } });
    if (path.endsWith("/checkPermissions")) return response({ resultCode: 0, permissions: [
      { permission: "team.authkey.create", accessAllowed: true },
      { permission: "team.authkey.apns.enhanced.access", accessAllowed: true }
    ] });
    if (path.endsWith("/list")) return response({ resultCode: 0, keys }, { csrf: "SCOPED_TOKEN", csrf_ts: "123" });
    if (path.endsWith("/get")) return response({ resultCode: 0, keys: keys.filter(k => k.keyId === new URLSearchParams(String(init!.body)).get("keyId")) });
    if (path.endsWith("/create")) { keys = [key]; return response({ resultCode: 0 }); }
    if (path.endsWith("/revoke")) { keys = []; return response({ resultCode: 0 }); }
    if (path.includes("/download?")) return new Response(pem());
    throw Error("Unexpected offline request");
  };
  const scope = { teamId, environment: "test", sessionFile, planFile, fetch };
  const options: kit.DeveloperKeyPlanOptions = { ...scope, primaryAppId, primaryAppIdentifier: identifier,
    ...(action === "create" ? { action, keyName: key.keyName } : action === "revoke" ? { action, keyId: key.keyId } : { action, keyId: key.keyId, output }) };
  return { session, key, scope, options, output, plan: () => kit.planDeveloperKey(options),
    override: (fn: typeof override) => { override = fn; }, keys: (value: typeof keys) => { keys = value; },
    attempts: () => attempts };
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, ordered(v)]));
  return value;
}
function rewrite(path: string, mutate: (raw: Record<string, unknown>) => void, integrity = "hash") {
  const raw: Record<string, unknown> = JSON.parse(fs.readFileSync(path, "utf8"));
  mutate(raw);
  const { [integrity]: _hash, ...contents } = raw;
  raw[integrity] = createHash("sha256").update(JSON.stringify(ordered(contents))).digest("hex");
  fs.writeFileSync(path, JSON.stringify(raw));
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); syncBuiltinESMExports(); });

it.each([
  { primaryAppIdentifier: "" }, { primaryAppIdentifier: "bad" }, { primaryAppIdentifier: `${teamId}.${identifier}` },
  { environment: "" }, { environment: "invalid label" }, { sessionFile: "" }, { planFile: "" },
  { action: "unsupported" }, { keyName: "" }, { keyName: " padded " }, { unexpected: true }
])("refuses invalid library planning intent before requests: %j", async change => {
  const s = fixture();
  await expect(kit.planDeveloperKey({ ...s.options, ...change } as unknown as kit.DeveloperKeyPlanOptions))
    .rejects.toMatchObject({ code: "invalid_arguments" });
  expect(s.attempts()).toBe(0);
});
it("refuses a missing download destination and scope overrides", async () => {
  const s = fixture("download");
  await expect(kit.planDeveloperKey({ ...s.options, action: "download", keyId: s.key.keyId, output: "" })).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(kit.applyDeveloperKey({ ...s.scope, action: "create" } as kit.DeveloperKeyScope)).rejects.toMatchObject({ code: "invalid_arguments" });
});
it.each(["null", "version", "uuid", "apiVersion", "fingerprint"])("refuses invalid normalized plan %s", async kind => {
  const s = fixture(); await s.plan();
  if (kind === "null") fs.writeFileSync(s.scope.planFile, "null");
  else rewrite(s.scope.planFile, raw => {
    if (kind === "version") raw.version = 2;
    if (kind === "uuid") raw.operationId = "not-an-operation";
    if (kind === "apiVersion") raw.apiVersion = "future";
    if (kind === "fingerprint") raw.fingerprint = "0".repeat(64);
  });
  await expect(kit.applyDeveloperKey(s.scope)).rejects.toMatchObject({ code: kind === "fingerprint" ? "stale_plan" : "invalid_plan" });
  expect(s.attempts()).toBe(0);
});
it.each(["shape", "entry", "duplicate", "denied", "missing"])("refuses unsupported permission response %s", async kind => {
  const s = fixture();
  s.override(url => url.endsWith("/checkPermissions") ? response({ resultCode: 0, permissions:
    kind === "shape" ? null : kind === "entry" ? [{}] : kind === "duplicate" ?
      [{ permission: "x", accessAllowed: true }, { permission: "x", accessAllowed: false }] :
      [{ permission: "team.authkey.create", accessAllowed: kind !== "denied" }] }) : undefined);
  await expect(s.plan()).rejects.toMatchObject({ code: kind === "denied" ? "permission_denied" : "invalid_response" });
  expect(s.attempts()).toBe(0);
});
it.each(["array", "key", "repeated", "limit"])("refuses invalid or nonprogressing key inventories %s", async kind => {
  const s = fixture();
  let page = 0;
  s.override(url => {
    if (!url.endsWith("/list")) return;
    page++;
    return response({ resultCode: 0, keys: kind === "array" ? null : kind === "key" ? [{}] :
      Array.from({ length: 50 }, (_, i) => ({ ...s.key, keyId: `P${String((kind === "limit" ? page * 50 : 0) + i).padStart(9, "0")}` })) });
  });
  await expect(s.plan()).rejects.toMatchObject({ code: kind === "repeated" ? "pagination_non_progress" : kind === "limit" ? "pagination_limit" : "invalid_response" });
});
it.each(["no-csrf", "new-name", "missing-list-key", "changed-get-name", "capability"])("rechecks scoped preconditions before effect: %s", async kind => {
  const s = fixture(kind === "missing-list-key" || kind === "changed-get-name" || kind === "capability" ? "revoke" : "create");
  await s.plan();
  if (kind === "capability") s.key.services[0]!.configurations[0]!.musicKitEnabled = true;
  else s.override(url => {
    if (kind === "changed-get-name" && url.endsWith("/get")) return response({ resultCode: 0, keys: [{ ...s.key, keyName: "Changed" }] });
    if (url.endsWith("/list")) return response({ resultCode: 0, keys: kind === "new-name" ? [s.key] : [] },
      kind === "no-csrf" ? {} : { csrf: "TOKEN", csrf_ts: "123" });
  });
  await expect(kit.applyDeveloperKey(s.scope)).rejects.toBeInstanceOf(kit.DeveloperError);
  expect(s.attempts()).toBe(0);
});
it("does not attribute creation to an inconsistently named key-get result", async () => {
  const s = fixture(); await s.plan();
  s.override(url => url.endsWith("/get") ? response({ resultCode: 0, keys: [{ ...s.key, keyName: "Other" }] }) : undefined);
  expect(await kit.applyDeveloperKey(s.scope)).toMatchObject({ state: "uncertain", errorCode: "resource_mismatch" });
  expect(s.attempts()).toBe(1);
});
it("completes exact revocation and refuses reconciliation with no intent", async () => {
  const s = fixture("revoke"); await s.plan();
  await expect(kit.reconcileDeveloperKey(s.scope)).rejects.toMatchObject({ code: "invalid_operation" });
  expect(await kit.applyDeveloperKey(s.scope)).toMatchObject({ state: "completed", action: "revoke" });
  expect(s.attempts()).toBe(1);
});

it.each(["header", "integrity", "resource", "create-key", "missing-key", "wrong-id", "extra", "recovery-create", "recovery-download",
  "completed-without-receipt", "receipt-null", "receipt-state", "receipt-pending", "receipt-hash", "receipt-code", "scope"])(
  "refuses corrupt persistent authority %s without a new effect", async kind => {
    const s = fixture(kind === "missing-key" ? "revoke" : kind === "receipt-hash" || kind === "recovery-download" ? "download" : "create");
    const plan = await s.plan();
    s.override(url => /\/(?:create|revoke|download)(?:\?|$)/.test(url) ? Promise.reject(Error(secret)) : undefined);
    await kit.applyDeveloperKey(s.scope);
    const operation = join(directory, `${plan.operationId}.json`);
    const original = fs.readFileSync(operation, "utf8");
    try {
      if (kind === "header") fs.writeFileSync(operation, "null");
      else rewrite(operation, raw => {
        if (kind === "integrity") raw.integrity = "broken";
        if (kind === "resource") raw.resource = "name:other";
        if (kind === "create-key") raw.keyId = "KEYS123456";
        if (kind === "missing-key") { delete raw.keyId; raw.resource = "key:undefined"; }
        if (kind === "wrong-id") raw.operationId = randomUUID();
        if (kind === "extra") raw.extra = true;
        if (kind.startsWith("recovery-")) raw.recoveryFile = file("wrong-recovery.p8");
        if (kind === "completed-without-receipt") { raw.state = "completed"; delete raw.receipt; }
        if (kind === "receipt-null") raw.receipt = null;
        if (kind === "receipt-state") raw.receipt = { ...(raw.receipt as object), state: "completed" };
        if (kind === "receipt-pending") { raw.state = "pending"; raw.receipt = { ...(raw.receipt as object), state: "pending" }; }
        if (kind === "receipt-hash") { raw.state = "completed"; raw.receipt = { ...(raw.receipt as object), state: "completed", sha256: "invalid" }; }
        if (kind === "receipt-code") raw.receipt = { ...(raw.receipt as object), errorCode: secret };
        if (kind === "scope") {
          raw.planHash = "0".repeat(64);
          raw.receipt = { ...(raw.receipt as object), planHash: raw.planHash };
        }
      }, "integrity");
      if (kind === "integrity") {
        const raw = JSON.parse(fs.readFileSync(operation, "utf8")); raw.integrity = "0".repeat(64);
        fs.writeFileSync(operation, JSON.stringify(raw));
      }
      await expect(kit.applyDeveloperKey(s.scope)).rejects.toBeInstanceOf(kit.DeveloperError);
      expect(s.attempts()).toBe(1);
    } finally { fs.writeFileSync(operation, original); }
  });

it.each(["record-limit", "index-limit", "malformed-index"])("refuses oversized or malformed authority indexes %s", async kind => {
  const s = fixture(); await s.plan();
  if (kind === "malformed-index") {
    const target = join(directory, `${"0".repeat(64)}.index.json`);
    fs.writeFileSync(target, "null", { mode: 0o600 });
    try { await expect(kit.applyDeveloperKey(s.scope)).rejects.toMatchObject({ code: "invalid_operation" }); }
    finally { fs.renameSync(target, file("retained-malformed-index.json")); }
  } else {
    const readdir = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementation(((path: fs.PathLike) => String(path) === directory ?
      Array.from({ length: 10_001 }, (_, i) => kind === "record-limit" ? `00000000-0000-4000-8000-${String(i).padStart(12, "0")}.json` :
        `${i.toString(16).padStart(64, "0")}.index.json`) : readdir(path)) as typeof fs.readdirSync);
    syncBuiltinESMExports();
    await expect(kit.applyDeveloperKey(s.scope)).rejects.toMatchObject({ code: "invalid_operation" });
  }
  expect(s.attempts()).toBe(0);
});
it("refuses a previously created resource even if its inventory name changed", async () => {
  const s = fixture(); await s.plan(); await kit.applyDeveloperKey(s.scope);
  s.keys([{ ...s.key, keyName: "Renamed" }]);
  await expect(kit.planDeveloperKey({ ...s.options, planFile: file("later-plan.json") })).rejects.toMatchObject({ code: "resource_exists" });
});
it("sanitizes non-protocol reconciliation faults", async () => {
  const s = fixture(); await s.plan();
  s.override(url => url.endsWith("/create") ? Promise.reject(Error(secret)) : undefined);
  await kit.applyDeveloperKey(s.scope);
  s.override(() => {
    const r = response({});
    Object.defineProperty(r, "headers", { get() { throw Error(secret); } });
    return r;
  });
  const result = await kit.reconcileDeveloperKey(s.scope);
  expect(result).toMatchObject({ state: "uncertain", errorCode: "unsafe_session_store" });
  expect(JSON.stringify(result)).not.toContain(secret);
});

it.each(["replaced", "short-read", "oversized-file", "wrong-recovery-hash", "wrong-output-hash"])("preserves download uncertainty on local verification failure %s", async kind => {
  const s = fixture("download"); await s.plan();
  const alternate = pem();
  const write = fs.writeFileSync;
  if (kind === "replaced") s.override(url => {
    if (url.includes("/download?")) {
      fs.renameSync(s.output, file("displaced-output"));
      fs.writeFileSync(s.output, "FOREIGN", { mode: 0o600 });
      return new Response(pem());
    }
  });
  else if (kind === "short-read") vi.spyOn(fs, "readSync").mockReturnValue(0);
  else vi.spyOn(fs, "writeFileSync").mockImplementation((fd, data, options) => {
    if (typeof fd === "number" && Buffer.isBuffer(data)) {
      const isOutput = fs.fstatSync(fd).ino === fs.statSync(s.output).ino;
      if (kind === "oversized-file") return write(fd, Buffer.alloc(17000, 65), options);
      if ((kind === "wrong-output-hash") === isOutput) return write(fd, alternate, options);
    }
    return write(fd, data, options);
  });
  syncBuiltinESMExports();
  expect(await kit.applyDeveloperKey(s.scope)).toMatchObject({ state: "uncertain", errorCode: "unsafe_output" });
  expect(s.attempts()).toBe(1);
  if (kind === "replaced") expect(fs.readFileSync(s.output, "utf8")).toBe("FOREIGN");
});

it.each([
  ["developer"], ["developer", "keys"], ["developer", "unknown"],
  ["developer", "keys", "plan", "--environment", "test"],
  ["developer", "keys", "plan", "--plan-file", "x"],
  ["developer", "keys", "plan", "--plan-file", "x", "--environment", "test", "--primary-app-id", primaryAppId],
  ["developer", "keys", "plan", "--plan-file", "x", "--environment", "test", "--primary-app-id", primaryAppId, "--primary-app-identifier", "bad"],
  ["developer", "keys", "plan", "--plan-file", "x", "--environment", "test", "--primary-app-id", primaryAppId, "--primary-app-identifier", identifier],
  ["developer", "keys", "plan", "--plan-file", "x", "--environment", "test", "--primary-app-id", primaryAppId, "--primary-app-identifier", identifier, "--action", "other"],
  ...["revoke", "download"].map(action => ["developer", "keys", "plan", "--plan-file", "x", "--environment", "test",
    "--primary-app-id", primaryAppId, "--primary-app-identifier", identifier, "--action", action, "--key-id", "KEYS123456",
    ...(action === "revoke" ? ["--output", "x"] : ["--key-name", "incompatible"])])
].map(args => ({ args })))("rejects invalid complete developer argv %#", async ({ args }) => {
  let output = "";
  expect(await developerCommand({ stdout: v => { output += v; }, stderr: v => { output += v; } },
    [...args, "--team-id", teamId, "--session-file", file("unused.json"), "--json"])).toBe(64);
  expect(JSON.parse(output).error.code).toBe("invalid_arguments");
});
it("enrolls from real local descriptor input via the default stdin adapter and refuses oversized stdin", async () => {
  const input = file("stdin.json");
  fs.writeFileSync(input, JSON.stringify(enrollment()), { mode: 0o600 });
  const fd = fs.openSync(input, "r");
  const read = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options: unknown) =>
    Reflect.apply(read, fs, [file === 0 ? fd : file, options])) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  const destination = file("stdin-session.json");
  let output = "";
  try {
    expect(await developerCommand({ stdout: v => { output += v; }, stderr: v => { output += v; } },
      ["developer", "session", "import", "--team-id", teamId, "--session-file", destination])).toBe(0);
    expect(JSON.parse(output)).toEqual({ enrolled: true, teamId });
    expect(kit.loadDeveloperSession({ teamId, sessionFile: destination }).cookieHeader("account/auth/key/list")).toContain("session=");
  } finally { fs.closeSync(fd); }
  expect(await developerCommand({ stdout() {}, stderr() {} }, ["developer", "session", "import", "--team-id", teamId,
    "--session-file", file("oversized.json")], { readStdin: () => "x".repeat(1024 * 1024 + 1) })).toBe(69);
});
it("uses default injected-global transport for CLI status and each lifecycle planning action", async () => {
  for (const action of ["create", "revoke", "download"] as const) {
    const s = fixture(action); vi.stubGlobal("fetch", s.scope.fetch);
    let output = "";
    const io = { stdout: (v: string) => { output += v; }, stderr: (v: string) => { output += v; } };
    expect(await developerCommand(io, ["developer", "status", "--team-id", teamId, "--session-file", s.scope.sessionFile])).toBe(0);
    output = "";
    expect(await developerCommand(io, ["developer", "keys", "plan", "--action", action, "--team-id", teamId, "--environment", "test",
      "--primary-app-id", primaryAppId, "--primary-app-identifier", identifier, "--session-file", s.scope.sessionFile,
      "--plan-file", s.scope.planFile, ...(action === "create" ? ["--key-name", s.key.keyName] : ["--key-id", s.key.keyId]),
      ...(action === "download" ? ["--output", s.output] : []), "--json"])).toBe(0);
    expect(JSON.parse(output).result.action).toBe(action);
  }
});
it("sanitizes an unexpected CLI host-I/O exception", async () => {
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  expect(await developerCommand(io, ["developer", "status", "--team-id", teamId, "--session-file", file("missing.json"), "--json"])).toBe(69);
  const s = fixture();
  io.stdout.mockImplementationOnce(() => { throw Error(secret); });
  expect(await developerCommand(io, ["developer", "status", "--team-id", teamId, "--session-file", s.scope.sessionFile, "--json"],
    { fetch: s.scope.fetch })).toBe(69);
  expect(JSON.stringify(io.stdout.mock.calls.at(-1))).not.toContain(secret);
});

it.each(["sameSite", "date-range", "jar-write"])("rejects invalid enrollment without publication: %s", kind => {
  const input: Record<string, unknown> = enrollment();
  const cookie = (input.cookies as Record<string, unknown>[])[0]!;
  if (kind === "sameSite") cookie.sameSite = "Unsafe";
  if (kind === "date-range") cookie.expires = Number.MAX_VALUE;
  if (kind === "jar-write") {
    const set = CookieJar.prototype.setCookieSync;
    let calls = 0;
    vi.spyOn(CookieJar.prototype, "setCookieSync").mockImplementation(function (this: CookieJar, ...args) {
      if (++calls === 2) throw Error(secret);
      return Reflect.apply(set, this, args);
    });
  }
  const target = file("rejected-enrollment.json");
  expect(() => kit.importDeveloperSession({ teamId, sessionFile: target, input })).toThrowError(expect.objectContaining({ code: "invalid_session" }));
  expect(fs.existsSync(target)).toBe(false);
});
it("retains valid expiring host-only SameSite cookies and refuses an expired direct credential read", () => {
  const s = kit.importDeveloperSession({ teamId, sessionFile: file("finite-session.json"), input: {
    teamId, cookies: [{ ...enrollment().cookies[0]!, domain: "developer.apple.com", expires: Date.now() / 1000 + 500, sameSite: "Lax" }]
  } });
  expect(s.cookieHeader("account/auth/key/list")).toContain("session=");
  s.refresh("account/auth/key/list", ["session=gone; Path=/; Secure; Max-Age=0"]);
  expect(() => s.cookieHeader("account/auth/key/list")).toThrowError(expect.objectContaining({ code: "session_expired" }));
});
it("refuses unsupported transport destinations and cross-team download credentials", async () => {
  const s = fixture();
  const fetch = vi.fn(s.scope.fetch);
  const t = createDeveloperTransport({ teamId, session: s.session, fetch });
  await expect(Reflect.apply(t.request, t, ["https://untrusted.invalid/", {}])).rejects.toMatchObject({ code: "invalid_arguments" });
  expect(() => s.session[developerTransportAccess]("account/auth/key/download?teamId=ELSE123456&keyId=KEYS123456"))
    .toThrowError(expect.objectContaining({ code: "team_mismatch" }));
  expect(() => Reflect.apply(developerTransportUrl, undefined, ["../create"])).toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("refuses invalid session containers and valid-but-wrong teams at both client boundaries", () => {
  const s = fixture();
  for (const create of [kit.createDeveloperClient, createDeveloperTransport]) {
    expect(() => create({ teamId, session: {} as kit.DeveloperSession })).toThrowError(expect.objectContaining({ code: "invalid_session" }));
    expect(() => create({ teamId: "ELSE123456", session: s.session })).toThrowError(expect.objectContaining({ code: "team_mismatch" }));
  }
});
it.each([
  { location: undefined, code: "redirect_rejected" },
  { location: "http://[", code: "redirect_rejected" },
  { location: "https://developer.apple.com/account/", code: "sign_in_required" }
])("classifies only known manual sign-in redirects %#", async ({ location, code }) => {
  const s = fixture();
  const fetch: typeof globalThis.fetch = async () => new Response("", { status: 302, headers: location ? { location } : {} });
  await expect(kit.createDeveloperClient({ teamId, session: s.session, fetch }).status()).rejects.toMatchObject({ code });
});
it.each(["wrong-url", "correct-url", "content-type", "empty-body"])("validates response boundaries %s", async kind => {
  const s = fixture();
  const fetch: typeof globalThis.fetch = async url => {
    const r = kind === "empty-body" ? new Response(null, { headers: { "content-type": "application/json" } }) :
      response({ resultCode: 0, keys: [] }, kind === "content-type" ? { "content-type": "application/octet-stream" } : {});
    if (kind.endsWith("url")) Object.defineProperty(r, "url", { value: kind === "wrong-url" ? "https://untrusted.invalid/" : String(url) });
    return r;
  };
  const result = kit.createDeveloperClient({ teamId, session: s.session, fetch }).status();
  if (kind === "correct-url") expect(await result).toMatchObject({ ready: true });
  else await expect(result).rejects.toMatchObject({ code: kind === "wrong-url" ? "redirect_rejected" : "invalid_response" });
});
it.each([
  { csrf: "invalid token", csrf_ts: "123" }, { csrf: "TOKEN", csrf_ts: "invalid" }
])("refuses malformed CSRF before vendor I/O %#", async csrf => {
  const s = fixture();
  const fetch = vi.fn(s.scope.fetch);
  const t = createDeveloperTransport({ teamId, session: s.session, fetch });
  await expect(t.request("account/auth/key/create", { csrf, json: {} })).rejects.toMatchObject({ code: "invalid_response" });
  expect(fetch).not.toHaveBeenCalled();
});
it("commits validated response cookies once even if the consumer acknowledges twice", async () => {
  const s = fixture();
  const t = createDeveloperTransport({ teamId, session: s.session, fetch: async () =>
    response({ resultCode: 0, keys: [] }, { "set-cookie": "session=UPDATED; Secure; Path=/; Domain=.apple.com" }) });
  const r = await t.request("account/auth/key/list", {});
  r.accept();
  const persisted = fs.readFileSync(s.scope.sessionFile, "utf8");
  r.accept();
  expect(fs.readFileSync(s.scope.sessionFile, "utf8")).toBe(persisted);
  expect(kit.loadDeveloperSession(s.scope).cookieHeader("account/auth/key/list")).toContain("session=UPDATED");
});
it("cancels oversized bodies safely even if the stream's cancellation fails", async () => {
  const s = fixture();
  const t = createDeveloperTransport({ teamId, session: s.session, fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(17_000)); },
    cancel() { return Promise.reject(Error(secret)); }
  })) });
  await expect(t.request(`account/auth/key/download?teamId=${teamId}&keyId=${s.key.keyId}`, { method: "GET", binary: true }))
    .rejects.toMatchObject({ code: "invalid_response" });
});
it("aborts and safely cancels a stalled response after headers arrive", async () => {
  const s = fixture();
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const t = createDeveloperTransport({ teamId, session: s.session, fetch: async () => new Response(new ReadableStream({
    pull() { return new Promise<void>(resolve => setImmediate(() => { controller.abort(); resolve(); })); },
    cancel() { return Promise.reject(Error(secret)); }
  }), { headers: { "content-type": "application/json" } }) });
  await expect(t.request("account/auth/key/list", {})).rejects.toMatchObject({ code: "network_error" });
});
it("handles cancellation failure on an already-expired response", async () => {
  const s = fixture();
  const controller = new AbortController(); controller.abort();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const t = createDeveloperTransport({ teamId, session: s.session, fetch: async () => new Response(new ReadableStream({
    cancel() { return Promise.reject(Error(secret)); }
  }), { headers: { "content-type": "application/json" } }) });
  await expect(t.request("account/auth/key/list", {})).rejects.toMatchObject({ code: "network_error" });
});
it("rejects malformed binary JSON rather than returning a success-shaped download", async () => {
  const s = fixture("download"); await s.plan();
  s.override(url => url.includes("/download?") ? new Response("{malformed") : undefined);
  expect(await kit.applyDeveloperKey(s.scope)).toMatchObject({ state: "uncertain", errorCode: "invalid_response" });
});
it("refuses malformed persisted sessions and non-contention lock-open failures", () => {
  const bad = file("bad-store.json");
  fs.writeFileSync(bad, "{", { mode: 0o600 });
  expect(() => readDeveloperPrivateInput(bad)).toThrowError(expect.objectContaining({ code: "invalid_session" }));
  fs.writeFileSync(bad, JSON.stringify({ version: 2, teamId, jar: {} }));
  expect(() => kit.loadDeveloperSession({ teamId, sessionFile: bad })).toThrowError(expect.objectContaining({ code: "invalid_session" }));
  expect(() => acquireDeveloperPrivateLock(join(file("missing-parent"), "store")))
    .toThrowError(expect.objectContaining({ code: "unsafe_session_store" }));
});
it("never replaces a symlink private store", () => {
  const target = file("unrelated.json");
  fs.writeFileSync(target, "UNCHANGED", { mode: 0o600 });
  const alias = file("alias.json"); fs.symlinkSync(target, alias);
  expect(() => writeDeveloperPrivateStore(alias, "REPLACED", true)).toThrowError(expect.objectContaining({ code: "unsafe_session_store" }));
  expect(fs.readFileSync(target, "utf8")).toBe("UNCHANGED");
});
it("closes staging descriptors and sanitizes an enrollment write failure", () => {
  const target = file("failed-publication.json");
  let failedFd: number | undefined;
  const write = fs.writeFileSync;
  vi.spyOn(fs, "writeFileSync").mockImplementation((fd, data, options) => {
    if (typeof fd === "number") { failedFd = fd; throw Error(secret); }
    write(fd, data, options);
  });
  syncBuiltinESMExports();
  expect(() => kit.importDeveloperSession({ teamId, sessionFile: target, input: enrollment() }))
    .toThrowError(expect.objectContaining({ code: "unsafe_session_store" }));
  expect(failedFd).toBeDefined();
  expect(() => fs.fstatSync(failedFd!)).toThrow();
  expect(fs.existsSync(target)).toBe(false);
});
it("does not remove a foreign replacement at its staging pathname", () => {
  const target = file("foreign-stage-session.json");
  const displaced = file("displaced-stage.json");
  let staging = "";
  vi.spyOn(fs, "linkSync").mockImplementation(from => {
    staging = String(from); fs.renameSync(from, displaced); fs.writeFileSync(from, "FOREIGN", { mode: 0o600 });
    throw Error(secret);
  });
  syncBuiltinESMExports();
  expect(() => kit.importDeveloperSession({ teamId, sessionFile: target, input: enrollment() }))
    .toThrowError(expect.objectContaining({ code: "unsafe_session_store" }));
  expect(fs.readFileSync(staging, "utf8")).toBe("FOREIGN");
  expect(fs.existsSync(displaced)).toBe(true);
  expect(fs.existsSync(target)).toBe(false);
});
it("reports missing developer commands and incomplete action options without transport", async () => {
  const io = { stdout() {}, stderr() {} };
  expect(await developerCommand(io, [])).toBe(64);
  expect(await developerCommand(io, ["developer", "keys"])).toBe(64);
  const s = fixture("download");
  expect(await developerCommand(io, ["developer", "keys", "plan", "--action", "download", "--key-id", s.key.keyId,
    "--team-id", teamId, "--environment", "test", "--primary-app-id", primaryAppId, "--primary-app-identifier", identifier,
    "--session-file", s.scope.sessionFile, "--plan-file", s.scope.planFile])).toBe(64);
});
it("lists only allowlisted inspection metadata through the actual CLI route", async () => {
  const s = fixture("revoke");
  let output = "";
  expect(await developerCommand({ stdout: v => { output += v; }, stderr: v => { output += v; } },
    ["developer", "keys", "list", "--team-id", teamId, "--session-file", s.scope.sessionFile, "--json"],
    { fetch: s.scope.fetch })).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ ok: true, result: [{ keyId: s.key.keyId, serviceIds: ["APPLE_ID_AUTH_KEY_CONFIGURATION"] }] });
  expect(output).not.toMatch(/configurations|PRIVATE_TEST_DATA/);
});
it("refuses plan publication into a permissive parent without a vendor effect", async () => {
  const s = fixture();
  const parent = file("public-plan-parent");
  fs.mkdirSync(parent, { mode: 0o755 });
  await expect(kit.planDeveloperKey({ ...s.options, planFile: join(parent, "plan.json") }))
    .rejects.toMatchObject({ code: "unsafe_session_store" });
  expect(s.attempts()).toBe(0);
});
it("refuses a replaced intent staging file before effect and preserves its foreign owner", async () => {
  const s = fixture(); await s.plan();
  const displaced = file("displaced-intent-stage");
  let replaced = "";
  const link = fs.linkSync;
  vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
    if (String(to).startsWith(directory)) {
      replaced = String(from);
      fs.renameSync(from, displaced);
      fs.writeFileSync(from, "FOREIGN", { mode: 0o600 });
      throw Error(secret);
    }
    link(from, to);
  });
  syncBuiltinESMExports();
  await expect(kit.applyDeveloperKey(s.scope)).rejects.toMatchObject({ code: "unsafe_session_store" });
  expect(fs.readFileSync(replaced, "utf8")).toBe("FOREIGN");
  expect(s.attempts()).toBe(0);
});
it("closes a reserved output descriptor when its initial durability barrier fails", async () => {
  const s = fixture("download"); await s.plan();
  const sync = fs.fsyncSync;
  let failedFd: number | undefined;
  vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
    const st = fs.fstatSync(fd);
    if (fs.existsSync(s.output) && st.isFile() && st.ino === fs.statSync(s.output).ino) {
      failedFd = fd; throw Error(secret);
    }
    sync(fd);
  });
  syncBuiltinESMExports();
  await expect(kit.applyDeveloperKey(s.scope)).rejects.toMatchObject({ code: "unsafe_output" });
  expect(failedFd).toBeDefined();
  expect(() => fs.fstatSync(failedFd!)).toThrow();
  expect(s.attempts()).toBe(0);
});
it("does not report a reconciled operation completed if its receipt cannot be persisted", async () => {
  const s = fixture(); const plan = await s.plan();
  s.override(url => url.endsWith("/create") ? Promise.reject(Error(secret)) : undefined);
  await kit.applyDeveloperKey(s.scope);
  s.override(undefined); s.keys([s.key]);
  const rename = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === join(directory, `${plan.operationId}.json`)) throw Error(secret);
    rename(from, to);
  });
  syncBuiltinESMExports();
  const result = await kit.reconcileDeveloperKey(s.scope);
  expect(result).toMatchObject({ state: "uncertain", errorCode: "unsafe_session_store" });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(s.attempts()).toBe(1);
});

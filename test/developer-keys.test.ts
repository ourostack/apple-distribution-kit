import fs, { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import * as kit from "../src/index.js";

const home = vi.hoisted(() => `${process.cwd()}/node_modules/.cache/developer-key-home-${Date.now()}-${process.pid}`);
vi.mock("node:os", () => ({ homedir: () => home }));
mkdirSync(home, { recursive: true, mode: 0o700 });
const inventory = join(home, "resources.json");
const resources: string[] = [home, inventory];
const originalWrite = fs.writeFileSync;
function recordResource(file: string): void {
  if (!resources.includes(file)) resources.push(file);
  originalWrite(inventory, JSON.stringify(resources), { mode: 0o600 });
}
const originalOpen = fs.openSync;
const originalMkdir = fs.mkdirSync;
const resourceSpies = [
  vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
    if (typeof file === "string" && typeof flags === "number" && (flags & fs.constants.O_CREAT)) recordResource(file);
    return originalOpen(file, flags, mode);
  }),
  vi.spyOn(fs, "mkdirSync").mockImplementation((file, options) => {
    if (typeof file === "string") recordResource(file);
    return originalMkdir(file, options);
  })
];
syncBuiltinESMExports();
afterAll(() => { resourceSpies.forEach(spy => spy.mockRestore()); syncBuiltinESMExports(); });
const teamId = "TEAM123456";
const primaryAppId = "APP1234567";
const primaryAppIdentifier = "org.example.primary";
const serviceId = "APPLE_ID_AUTH_KEY_CONFIGURATION";
const secret = "NEVER_EXPOSE_COOKIE_CSRF_OR_PEM";
let sequence = 0;
function path(label: string): string {
  const result = join(home, `${++sequence}-${label}`);
  resources.push(result);
  writeFileSync(inventory, JSON.stringify(resources), { mode: 0o600 });
  return result;
}
function fixture(name: string, id = "KEY1234567") {
  return {
    keyId: id, keyName: name, canRevoke: true, canDownload: true,
    creatorName: "Example Creator", creatorEmail: "creator@example.invalid",
    services: [{
      id: serviceId, name: "Sign in with Apple", relatedKeys: [],
      configurations: [{ id: primaryAppId, identifier: `${teamId}.${primaryAppIdentifier}`, type: "bundle",
        name: "Example Primary", musicKitEnabled: false, shazamKitEnabled: false, musicFeedEnabled: false }]
    }]
  };
}
type Key = ReturnType<typeof fixture>;
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });
function setup(action: "create" | "revoke" | "download" = "create") {
  const name = `Example ${sequence + 1}`;
  const sessionFile = path("session.json");
  kit.importDeveloperSession({ teamId, sessionFile, input: {
    teamId, cookies: [{ name: "session", value: secret, domain: ".apple.com", path: "/", secure: true, httpOnly: true, expires: -1 }]
  } });
  const planFile = path("plan.json");
  const output = path("download.p8");
  const key = fixture(name, `K${String(sequence).padStart(9, "0")}`);
  let keys: Key[] = action === "create" ? [] : [key];
  let enhanced = true;
  let effect: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  const seen: { url: string; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, init: init! });
    if (/\/(create|revoke|download)(\?|$)/.test(url)) {
      if (effect) return effect(url, init!);
      if (url.endsWith("/revoke")) keys = [];
      else if (url.endsWith("/create")) keys = [key];
      return json({ resultCode: 0 });
    }
    if (url.includes("/bundleIds/")) return json({ data: {
      type: "bundleIds", id: primaryAppId, attributes: { identifier: primaryAppIdentifier, seedId: teamId }
    } }, { "content-type": "application/vnd.api+json" });
    if (url.endsWith("/checkPermissions")) return json({ resultCode: 0, permissions: [
      { permission: "team.authkey.apns.enhanced.access", accessAllowed: enhanced },
      { permission: "team.authkey.create", accessAllowed: true }
    ] });
    if (url.endsWith("/list")) return json({ resultCode: 0, keys: keys.map(k => ({
      ...k, services: k.services.map(s => ({ id: s.id, name: s.name, topicsCount: 1 }))
    })) }, { csrf: secret, csrf_ts: "1700000000000" });
    if (url.endsWith("/get")) {
      const id = new URLSearchParams(String(init!.body)).get("keyId");
      return json({ resultCode: 0, keys: keys.filter(k => k.keyId === id) });
    }
    throw new Error("Unexpected request");
  };
  const common = { teamId, environment: "test", sessionFile, planFile, fetch };
  const plan = () => kit.planDeveloperKey({
    ...common, primaryAppId, primaryAppIdentifier,
    ...(action === "create" ? { action, keyName: name } : action === "revoke" ? { action, keyId: key.keyId } : { action, keyId: key.keyId, output })
  });
  return { common, plan, output, key, seen, setKeys: (value: Key[]) => { keys = value; },
    setEnhanced: (value: boolean) => { enhanced = value; }, setEffect: (value: typeof effect) => { effect = value; } };
}
const effects = (s: ReturnType<typeof setup>) => s.seen.filter(x => /\/(create|revoke|download)(\?|$)/.test(x.url));
const operations = () => {
  const directory = join(home, ".apple-distribution-kit", "developer-operations", teamId);
  return existsSync(directory) ? readdirSync(directory).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))
    .map(n => ({ file: join(directory, n), value: JSON.parse(readFileSync(join(directory, n), "utf8")) })) : [];
};
const pem = () => generateKeyPairSync("ec", { namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;

describe("guarded SIWA lifecycle", () => {
  it("exports only typed lifecycle entry points, not arbitrary mutation transport", () => {
    expect(typeof Reflect.get(kit, "planDeveloperKey")).toBe("function");
    expect(typeof Reflect.get(kit, "applyDeveloperKey")).toBe("function");
    expect(typeof Reflect.get(kit, "reconcileDeveloperKey")).toBe("function");
    expect(Reflect.get(kit, "developerRequest")).toBeUndefined();
  });

  it("durably publishes every new authority ancestor and the intent/index before a vendor effect", async () => {
    const s = setup();
    const authority = join(home, ".apple-distribution-kit");
    const operationRoot = join(authority, "developer-operations");
    const teamRoot = join(operationRoot, teamId);
    expect(existsSync(authority)).toBe(false);
    const events: { kind: string; path: string; inode?: number }[] = [];
    const opened = new Map<number, string>();
    const directoryDescriptors = new Set<number>();
    const mkdirMock = vi.mocked(fs.mkdirSync);
    const mkdir = mkdirMock.getMockImplementation()!;
    const openMock = vi.mocked(fs.openSync);
    const open = openMock.getMockImplementation()!;
    const sync = fs.fsyncSync;
    const close = fs.closeSync;
    const link = fs.linkSync;
    mkdirMock.mockImplementation((file, options) => {
      const result = mkdir(file, options);
      events.push({ kind: "mkdir", path: String(file) });
      return result;
    });
    openMock.mockImplementation((file, flags, mode) => {
      const fd = open(file, flags, mode);
      opened.set(fd, String(file));
      if (fs.fstatSync(fd).isDirectory()) directoryDescriptors.add(fd);
      return fd;
    });
    const spies = [
      vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
        sync(fd);
        const st = fs.fstatSync(fd);
        events.push({ kind: st.isDirectory() ? "sync-directory" : "sync-file", path: opened.get(fd)!, inode: st.ino });
      }),
      vi.spyOn(fs, "closeSync").mockImplementation(fd => {
        close(fd);
        directoryDescriptors.delete(fd);
        opened.delete(fd);
      }),
      vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
        link(from, to);
        events.push({ kind: "publish", path: String(to), inode: statSync(to).ino });
      })
    ];
    syncBuiltinESMExports();
    let effectAt = -1;
    s.setEffect(async () => { effectAt = events.length; s.setKeys([s.key]); return json({ resultCode: 0 }); });
    try {
      await s.plan();
      expect(await kit.applyDeveloperKey(s.common)).toMatchObject({ state: "completed" });
      const beforeEffect = events.slice(0, effectAt);
      const hierarchy = beforeEffect.filter(e => e.kind === "mkdir" ||
        (e.kind === "sync-directory" && [home, authority, operationRoot].includes(e.path)));
      expect(hierarchy.slice(0, 6).map(({ kind, path }) => ({ kind, path }))).toEqual([
        { kind: "mkdir", path: authority }, { kind: "sync-directory", path: home },
        { kind: "mkdir", path: operationRoot }, { kind: "sync-directory", path: authority },
        { kind: "mkdir", path: teamRoot }, { kind: "sync-directory", path: operationRoot }
      ]);
      const publications = beforeEffect.filter(e => e.kind === "publish" &&
        (e.path.endsWith(".index.json") || /\/[a-f0-9-]{36}\.json$/.test(e.path)));
      expect(publications).toHaveLength(2);
      for (const publication of publications) {
        const publishedAt = beforeEffect.indexOf(publication);
        expect(beforeEffect.slice(0, publishedAt).some(e => e.kind === "sync-file" && e.inode === publication.inode)).toBe(true);
        expect(beforeEffect.slice(publishedAt + 1).some(e => e.kind === "sync-directory" && e.path === teamRoot)).toBe(true);
      }
      expect(effectAt).toBeGreaterThan(0);
      expect(directoryDescriptors.size).toBe(0);
      expect(effects(s)).toHaveLength(1);
    } finally {
      mkdirMock.mockImplementation(mkdir);
      openMock.mockImplementation(open);
      spies.forEach(spy => spy.mockRestore());
      syncBuiltinESMExports();
    }
  });

  it("fails closed and closes the containing-directory descriptor when hierarchy publication fsync fails", async () => {
    const sessionFile = path("sync-failure-session.json");
    const syncTeam = "SYNC123456";
    kit.importDeveloperSession({ teamId: syncTeam, sessionFile, input: {
      teamId: syncTeam, cookies: [{ name: "session", value: secret, domain: ".apple.com", path: "/", secure: true, httpOnly: true, expires: -1 }]
    } });
    const containing = statSync(join(home, ".apple-distribution-kit", "developer-operations"));
    const sync = fs.fsyncSync;
    let directoryFd: number | undefined;
    const failure = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      const st = fs.fstatSync(fd);
      if (st.isDirectory() && st.dev === containing.dev && st.ino === containing.ino) {
        directoryFd = fd;
        throw new Error(secret);
      }
      sync(fd);
    });
    syncBuiltinESMExports();
    const fetch = vi.fn(async () => { throw new Error(secret); });
    try {
      const error = await kit.planDeveloperKey({ teamId: syncTeam, sessionFile, fetch,
        environment: "test", planFile: path("sync-failure-plan.json"), action: "create", keyName: "Example",
        primaryAppId, primaryAppIdentifier }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "unsafe_session_store" });
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(directoryFd).toBeDefined();
      expect(() => fs.fstatSync(directoryFd!)).toThrow();
      expect(fetch).not.toHaveBeenCalled();
    } finally { failure.mockRestore(); syncBuiltinESMExports(); }
  });

  it.each([true, false])("plans without effects and sends exact named-permission selected creation payload (%s)", async enhanced => {
    const s = setup();
    s.setEnhanced(enhanced);
    const plan = await s.plan();
    expect(effects(s)).toHaveLength(0);
    expect(statSync(s.common.planFile).mode & 0o777).toBe(0o600);
    const bundle = s.seen.find(x => x.url.includes("/bundleIds/"))!;
    expect(bundle.url).toBe("https://developer.apple.com/services-account/v1/bundleIds/APP1234567?fields[bundleIds]=name,identifier,seedId&include=bundleIdCapabilities.relatedAppConsentBundleIds");
    expect(bundle.init.method).toBe("POST");
    expect(new Headers(bundle.init.headers).get("X-HTTP-Method-Override")).toBe("GET");
    expect(new Headers(bundle.init.headers).get("X-Requested-With")).toBe("XMLHttpRequest");
    expect(new Headers(bundle.init.headers).get("content-type")).toBe("application/vnd.api+json");
    expect(JSON.parse(String(bundle.init.body))).toEqual({ teamId });
    const permissions = s.seen.find(x => x.url.endsWith("/checkPermissions"))!;
    expect(permissions.url).toBe("https://developer.apple.com/services-account/checkPermissions");
    expect(new URLSearchParams(String(permissions.init.body)).get("permissions")).toBe("team.authkey.create,team.authkey.apns.enhanced.access");
    const receipt = await kit.applyDeveloperKey(s.common);
    expect(receipt).toMatchObject({ state: "completed", action: "create", keyId: s.key.keyId, operationId: plan.operationId });
    const call = effects(s)[0]!;
    expect(call.url).toBe(`https://developer.apple.com/services-account/QH65B2/account/auth/key/${enhanced ? "v2/create" : "create"}`);
    expect(new Headers(call.init.headers).get("content-type")).toBe("application/json");
    expect(new Headers(call.init.headers).get("csrf")).toBe(secret);
    expect(new Headers(call.init.headers).get("csrf_ts")).toBe("1700000000000");
    expect(call.init.redirect).toBe("manual");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(call.init.body))).toEqual(enhanced ? {
      teamId, name: s.key.keyName, serviceConfigurationsRequests: [{ serviceId, isNew: true, identifiers: { bundle: [primaryAppId] } }]
    } : { teamId, name: s.key.keyName, serviceConfigurations: { [serviceId]: [primaryAppId] } });
    expect(JSON.stringify(receipt)).not.toMatch(/Example Creator|creator@example|NEVER_EXPOSE|configurations/);
    const before = s.seen.length;
    expect(await kit.applyDeveloperKey(s.common)).toEqual(receipt);
    expect(s.seen).toHaveLength(before);
  });

  it("refuses a changed supported creation version before effect", async () => {
    const s = setup(); await s.plan(); s.setEnhanced(false);
    await expect(kit.applyDeveloperKey(s.common)).rejects.toMatchObject({ code: "stale_plan" });
    expect(effects(s)).toHaveLength(0);
  });

  it.each(["team", "identifier", "id", "type"])("refuses mismatched bundle %s before planning", async field => {
    const s = setup();
    const fetch: typeof globalThis.fetch = async () => json({ data: {
      type: field === "type" ? "other" : "bundleIds",
      id: field === "id" ? "OTHER12345" : primaryAppId,
      attributes: { identifier: field === "identifier" ? "org.other" : primaryAppIdentifier, seedId: field === "team" ? "OTHER12345" : teamId }
    } });
    await expect(kit.planDeveloperKey({ ...s.common, fetch, action: "create", primaryAppId, primaryAppIdentifier, keyName: s.key.keyName }))
      .rejects.toMatchObject({ code: "resource_mismatch" });
    expect(existsSync(s.common.planFile)).toBe(false);
  });

  it.each(["service", "configuration", "id", "identifier", "type", "canRevoke"])("refuses unexpected exact-key binding %s", async field => {
    const s = setup("revoke");
    const key = structuredClone(s.key);
    if (field === "service") key.services.push({ ...key.services[0]!, id: "OTHER_SERVICE" });
    if (field === "configuration") key.services[0]!.configurations.push({ ...key.services[0]!.configurations[0]! });
    if (field === "id") key.services[0]!.configurations[0]!.id = "OTHER12345";
    if (field === "identifier") key.services[0]!.configurations[0]!.identifier = "OTHER12345.org.other";
    if (field === "type") key.services[0]!.configurations[0]!.type = "service";
    if (field === "canRevoke") key.canRevoke = false;
    s.setKeys([key]);
    await expect(s.plan()).rejects.toBeInstanceOf(kit.DeveloperError);
    expect(effects(s)).toHaveLength(0);
  });

  it("refuses existing same-name creation and preserves an unrelated plan file", async () => {
    const s = setup(); s.setKeys([s.key]);
    await expect(s.plan()).rejects.toMatchObject({ code: "resource_exists" });
    s.setKeys([]);
    writeFileSync(s.common.planFile, "UNRELATED", { mode: 0o600 });
    await expect(s.plan()).rejects.toBeInstanceOf(kit.DeveloperError);
    expect(readFileSync(s.common.planFile, "utf8")).toBe("UNRELATED");
  });

  it.each(["name", "output", "hash", "unknown"])("rejects tampered plan %s before vendor traffic", async field => {
    const s = setup("download"); await s.plan();
    const raw = JSON.parse(readFileSync(s.common.planFile, "utf8"));
    if (field === "name") raw.keyName = "Other";
    if (field === "output") raw.output = path("other.p8");
    if (field === "hash") raw.hash = "0".repeat(64);
    if (field === "unknown") raw.extra = true;
    writeFileSync(s.common.planFile, JSON.stringify(raw));
    s.seen.length = 0;
    await expect(kit.applyDeveloperKey(s.common)).rejects.toMatchObject({ code: "invalid_plan" });
    expect(s.seen).toHaveLength(0);
  });

  it("rejects wrong team/environment and stale or disappeared key before effect", async () => {
    const s = setup("revoke"); await s.plan();
    await expect(kit.applyDeveloperKey({ ...s.common, teamId: "OTHER12345" })).rejects.toMatchObject({ code: "team_mismatch" });
    await expect(kit.applyDeveloperKey({ ...s.common, environment: "production" })).rejects.toMatchObject({ code: "scope_mismatch" });
    s.setKeys([{ ...s.key, keyName: "Renamed" }]);
    await expect(kit.applyDeveloperKey(s.common)).rejects.toMatchObject({ code: "stale_plan" });
    s.setKeys([]);
    await expect(kit.applyDeveloperKey(s.common)).rejects.toBeInstanceOf(kit.DeveloperError);
    expect(effects(s)).toHaveLength(0);
  });

  it.each(["create", "revoke", "download"] as const)("persists intent before %s and never retries network uncertainty, including a cloned session and fresh plan", async action => {
    const s = setup(action); await s.plan();
    s.setEffect(async () => {
      const op = operations().find(o => o.value.planFile === s.common.planFile)!;
      expect(op.value.state).toBe("pending");
      expect(statSync(op.file).mode & 0o777).toBe(0o600);
      throw new Error(secret);
    });
    const result = await kit.applyDeveloperKey(s.common);
    expect(result).toMatchObject({ state: "uncertain", action });
    expect(JSON.stringify(result)).not.toContain(secret);
    await kit.applyDeveloperKey(s.common);
    expect(effects(s)).toHaveLength(1);
    const clone = path("clone.json");
    writeFileSync(clone, readFileSync(s.common.sessionFile), { mode: 0o600 });
    const nextPlan = path("fresh-plan.json");
    await expect(kit.planDeveloperKey({
      ...s.common, sessionFile: clone, planFile: nextPlan, environment: "different-label", primaryAppId, primaryAppIdentifier,
      ...(action === "create" ? { action, keyName: s.key.keyName } : action === "revoke" ? { action, keyId: s.key.keyId } : { action, keyId: s.key.keyId, output: path("fresh.p8") })
    })).rejects.toMatchObject({ code: "operation_pending" });
    expect(effects(s)).toHaveLength(1);
  });

  it("contends real cooperating apply calls while preserving the pre-request record", async () => {
    const s = setup(); await s.plan();
    let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>(r => { entered = r; });
    const wait = new Promise<void>(r => { release = r; });
    s.setEffect(async () => { entered(); await wait; s.setKeys([s.key]); return json({ resultCode: 0 }); });
    const first = kit.applyDeveloperKey(s.common);
    await ready;
    try { await expect(kit.applyDeveloperKey(s.common)).rejects.toMatchObject({ code: "session_store_busy" }); }
    finally { release(); }
    expect(await first).toMatchObject({ state: "completed" });
    expect(effects(s)).toHaveLength(1);
  });

  it("refuses a second process under the same durable team lock", async () => {
    const s = setup(); await s.plan();
    const moduleDirectory = path("worker-modules");
    mkdirSync(moduleDirectory, { mode: 0o700 });
    for (const source of ["developer-keys", "developer-private-operations", "developer-session", "developer-transport", "plan"]) {
      const output = join(moduleDirectory, `${source}.js`);
      recordResource(output);
      writeFileSync(output, transpileModule(readFileSync(join(process.cwd(), "src", `${source}.ts`), "utf8"), {
        compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ES2022 }
      }).outputText, { mode: 0o600 });
    }
    let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>(r => { entered = r; });
    const wait = new Promise<void>(r => { release = r; });
    s.setEffect(async () => { entered(); await wait; s.setKeys([s.key]); return json({ resultCode: 0 }); });
    const first = kit.applyDeveloperKey(s.common);
    await ready;
    try {
      const worker = spawn(process.execPath, ["--input-type=module", "--eval", `
        import os from "node:os";
        import { syncBuiltinESMExports } from "node:module";
        os.homedir = () => ${JSON.stringify(home)};
        syncBuiltinESMExports();
        const { applyDeveloperKey } = await import(${JSON.stringify(pathToFileURL(join(moduleDirectory, "developer-keys.js")).href)});
        try {
          await applyDeveloperKey({
            ...${JSON.stringify({ ...s.common, fetch: undefined })},
            fetch: async () => { throw new Error("Offline worker must not issue requests"); }
          });
          process.exitCode = 2;
        } catch (error) {
          process.stdout.write(JSON.stringify({ code: error.code }));
          process.exitCode = error.code === "session_store_busy" ? 0 : 3;
        }
      `], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      worker.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      worker.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      const code = await new Promise<number | null>((resolve, reject) => {
        worker.once("error", reject); worker.once("close", resolve);
      });
      expect(code, output).toBe(0);
      expect(JSON.parse(output)).toEqual({ code: "session_store_busy" });
    } finally { release(); await first; }
    expect(effects(s)).toHaveLength(1);
  });

  it("reconciles unique creation read-only, but absence never authorizes a duplicate create", async () => {
    const s = setup(); await s.plan();
    s.setEffect(async () => { throw new Error(secret); });
    await kit.applyDeveloperKey(s.common);
    expect(await kit.reconcileDeveloperKey(s.common)).toMatchObject({ state: "uncertain" });
    s.setKeys([s.key]);
    const receipt = await kit.reconcileDeveloperKey(s.common);
    expect(receipt).toMatchObject({ state: "completed", keyId: s.key.keyId });
    expect(effects(s)).toHaveLength(1);
    expect(JSON.stringify(receipt)).not.toMatch(/Creator|creator@example|NEVER_EXPOSE/);
    // A later intentional same-name create must first verify the earlier resource absent.
    s.setKeys([]);
    await kit.planDeveloperKey({ ...s.common, planFile: path("later.json"), action: "create", primaryAppId, primaryAppIdentifier, keyName: s.key.keyName });
  });

  it("reconciles revocation only on exact inventory absence and uses scoped form", async () => {
    const s = setup("revoke"); await s.plan();
    s.setEffect(async () => json({ resultCode: 0 }));
    expect(await kit.applyDeveloperKey(s.common)).toMatchObject({ state: "uncertain" });
    expect(await kit.reconcileDeveloperKey(s.common)).toMatchObject({ state: "uncertain" });
    s.setKeys([fixture("unrelated", "OTHER12345")]);
    expect(await kit.reconcileDeveloperKey(s.common)).toMatchObject({ state: "completed", keyId: s.key.keyId });
    const call = effects(s)[0]!;
    expect(call.init.method).toBe("POST");
    expect(String(call.init.body)).toBe(`teamId=TEAM123456&keyId=${s.key.keyId}`);
    expect(effects(s)).toHaveLength(1);
  });

  it.each([
    { kind: "agreement", code: "agreement_required", human: "developer_agreement_required" },
    { kind: "unauthorized", code: "sign_in_required", human: "developer_sign_in_required" },
    { kind: "login-redirect", code: "sign_in_required", human: "developer_sign_in_required" }
  ])("preserves the $kind human gate during read-only reconciliation", async ({ kind, code, human }) => {
    const s = setup(); await s.plan();
    s.setEffect(async () => { throw new Error(secret); });
    await kit.applyDeveloperKey(s.common);
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/list")) {
        return kind === "agreement" ? json({ resultCode: 2100, resultString: secret }) :
          kind === "unauthorized" ? new Response(secret, { status: 401 }) :
            new Response(secret, { status: 302, headers: { location: "https://idmsa.apple.com/login" } });
      }
      return s.common.fetch(url, init);
    };
    const result = await kit.reconcileDeveloperKey({ ...s.common, fetch });
    expect(result).toMatchObject({ state: "uncertain", errorCode: code,
      requiresHuman: { type: "requiresHuman", code: human } });
    expect(JSON.stringify(result)).not.toMatch(/NEVER_EXPOSE|resultString|creator@example/);
    let output = "";
    const cli = kit.createCli({ stdout: v => { output += v; }, stderr: v => { output += v; } }, { developer: { fetch } });
    expect(await cli(["developer", "keys", "reconcile", "--team-id", teamId, "--environment", "test",
      "--session-file", s.common.sessionFile, "--plan-file", s.common.planFile, "--json"])).toBe(69);
    expect(JSON.parse(output)).toMatchObject({ ok: false, result: {
      state: "uncertain", errorCode: code, requiresHuman: { type: "requiresHuman", code: human }
    } });
    expect(output).not.toContain(secret);
    await kit.applyDeveloperKey(s.common);
    expect(effects(s)).toHaveLength(1);
  });

  it.each((["create", "revoke"] as const).flatMap(action =>
    (["missing", "malformed", "unsafe", "wrong-team"] as const).map(kind => ({ action, kind }))
  ))("SDK-R2 preserves pending $action identity across $kind session failure and read-only recovery", async ({ action, kind }) => {
    const s = setup(action);
    const plan = await s.plan();
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).includes("/developer-operations/") && String(to).endsWith(`${plan.operationId}.json`)) throw new Error(secret);
      rename(from, to);
    });
    syncBuiltinESMExports();
    try { expect(await kit.applyDeveloperKey(s.common)).toMatchObject({ state: "uncertain" }); }
    finally { failure.mockRestore(); syncBuiltinESMExports(); }
    const op = operations().find(o => o.value.operationId === plan.operationId)!;
    expect(op.value.state).toBe("pending");
    const originalIntent = readFileSync(op.file, "utf8");
    const backup = path("retained-fake-session.json");
    renameSync(s.common.sessionFile, backup);
    if (kind !== "missing") {
      writeFileSync(s.common.sessionFile, kind === "malformed" ? "{" : readFileSync(backup, "utf8"), { mode: 0o600 });
      if (kind === "unsafe") chmodSync(s.common.sessionFile, 0o644);
      if (kind === "wrong-team") {
        const stored = JSON.parse(readFileSync(s.common.sessionFile, "utf8"));
        stored.teamId = "OTHER12345";
        writeFileSync(s.common.sessionFile, JSON.stringify(stored));
      }
    }
    const code = kind === "unsafe" ? "unsafe_session_store" : kind === "wrong-team" ? "team_mismatch" : "invalid_session";
    const count = s.seen.length;
    const result = await kit.reconcileDeveloperKey(s.common);
    expect(result).toMatchObject({ ...plan, state: "uncertain", errorCode: code });
    expect(result.requiresHuman).toBeUndefined();
    let output = "";
    const cli = kit.createCli({ stdout: v => { output += v; }, stderr: v => { output += v; } }, { developer: { fetch: s.common.fetch } });
    expect(await cli(["developer", "keys", "reconcile", "--team-id", teamId, "--environment", "test",
      "--session-file", s.common.sessionFile, "--plan-file", s.common.planFile, "--json"])).toBe(69);
    expect(JSON.parse(output)).toEqual({ ok: false, result });
    expect(output).not.toMatch(/requiresHuman|NEVER_EXPOSE/);
    expect(output).not.toContain(s.common.sessionFile);
    expect(s.seen).toHaveLength(count);
    expect(readFileSync(op.file, "utf8")).toBe(originalIntent);
    expect(await kit.applyDeveloperKey(s.common)).toMatchObject({ operationId: plan.operationId, state: "uncertain" });
    renameSync(backup, s.common.sessionFile);
    const completed = await kit.reconcileDeveloperKey(s.common);
    expect(completed).toMatchObject({ ...plan, state: "completed" });
    expect(await kit.applyDeveloperKey(s.common)).toEqual(completed);
    expect(effects(s)).toHaveLength(1);
  });

  it.each(["missing", "malformed", "unsafe", "wrong-team"] as const)(
    "SDK-R2 retains ordinary %s session refusal before an intent exists", async kind => {
      const s = setup();
      await s.plan();
      const backup = path("retained-pre-intent-fake-session.json");
      renameSync(s.common.sessionFile, backup);
      if (kind !== "missing") {
        writeFileSync(s.common.sessionFile, kind === "malformed" ? "{" : readFileSync(backup, "utf8"), { mode: 0o600 });
        if (kind === "unsafe") chmodSync(s.common.sessionFile, 0o644);
        if (kind === "wrong-team") {
          const stored = JSON.parse(readFileSync(s.common.sessionFile, "utf8"));
          stored.teamId = "OTHER12345";
          writeFileSync(s.common.sessionFile, JSON.stringify(stored));
        }
      }
      const count = s.seen.length;
      const code = kind === "unsafe" ? "unsafe_session_store" : kind === "wrong-team" ? "team_mismatch" : "invalid_session";
      await expect(kit.applyDeveloperKey(s.common)).rejects.toMatchObject({ code, requiresHuman: undefined });
      let output = "";
      const cli = kit.createCli({ stdout: v => { output += v; }, stderr: v => { output += v; } }, { developer: { fetch: s.common.fetch } });
      expect(await cli(["developer", "keys", "apply", "--team-id", teamId, "--environment", "test",
        "--session-file", s.common.sessionFile, "--plan-file", s.common.planFile, "--json"])).toBe(69);
      expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code } });
      expect(JSON.parse(output).result).toBeUndefined();
      expect(output).not.toMatch(/requiresHuman|NEVER_EXPOSE/);
      expect(s.seen).toHaveLength(count);
      expect(operations().some(o => o.value.planFile === s.common.planFile)).toBe(false);
      renameSync(backup, s.common.sessionFile);
    }
  );

  it.each(["http", "body", "wrong-primary", "postcondition"])("blocks malformed/failed create %s without retry", async failure => {
    const s = setup(); await s.plan();
    s.setEffect(async () => {
      if (failure === "http") return new Response(secret, { status: 500 });
      if (failure === "body") return json({ resultCode: "0", secret });
      if (failure === "wrong-primary") {
        const key = structuredClone(s.key); key.services[0]!.configurations[0]!.id = "OTHER12345"; s.setKeys([key]);
      }
      return json({ resultCode: 0 });
    });
    expect(await kit.applyDeveloperKey(s.common)).toMatchObject({ state: "uncertain" });
    await kit.applyDeveloperKey(s.common);
    expect(effects(s)).toHaveLength(1);
  });

  it.each(["http", "body"])("does not retry uncertain revoke %s", async failure => {
    const s = setup("revoke"); await s.plan();
    s.setEffect(async () => failure === "http" ? new Response(secret, { status: 500 }) : json({ resultCode: "0", secret }));
    expect(await kit.applyDeveloperKey(s.common)).toMatchObject({ state: "uncertain" });
    await kit.applyDeveloperKey(s.common);
    expect(effects(s)).toHaveLength(1);
  });

  it("retains fsynced pending intent if receipt publication fails after creation", async () => {
    const s = setup(); await s.plan();
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).includes("/developer-operations/") && /^[a-f0-9-]{36}\.json$/.test(String(to).split("/").at(-1)!)) {
        throw new Error(secret);
      }
      rename(from, to);
    });
    syncBuiltinESMExports();
    try { expect(await kit.applyDeveloperKey(s.common)).toMatchObject({ state: "uncertain" }); }
    finally { failure.mockRestore(); syncBuiltinESMExports(); }
    expect(operations().find(o => o.value.planFile === s.common.planFile)!.value.state).toBe("pending");
    await kit.applyDeveloperKey(s.common);
    expect(effects(s)).toHaveLength(1);
    expect(await kit.reconcileDeveloperKey(s.common)).toMatchObject({ state: "completed" });
  });

  it("retains the explicit agreement gate after a single attempted effect", async () => {
    const s = setup(); await s.plan();
    s.setEffect(async () => json({ resultCode: 2100, resultString: secret }));
    const result = await kit.applyDeveloperKey(s.common);
    expect(result).toMatchObject({ state: "uncertain", requiresHuman: {
      type: "requiresHuman", code: "developer_agreement_required", url: "https://developer.apple.com/register/agree/"
    } });
    expect(await kit.applyDeveloperKey(s.common)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(effects(s)).toHaveLength(1);
  });

  it("retains the numeric agreement gate in a non-PEM download error body without accepting JSON success", async () => {
    const s = setup("download"); await s.plan();
    s.setEffect(async () => json({ resultCode: 2100, resultString: secret }));
    const result = await kit.applyDeveloperKey(s.common);
    expect(result).toMatchObject({ state: "uncertain", errorCode: "agreement_required", requiresHuman: {
      type: "requiresHuman", code: "developer_agreement_required"
    } });
    expect(await kit.applyDeveloperKey(s.common)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(effects(s)).toHaveLength(1);
  });

  it("refuses an owned lock replaced during preflight before any effect", async () => {
    const s = setup(); await s.plan();
    const lock = join(home, ".apple-distribution-kit", "developer-operations", teamId, "operations.refresh.lock");
    const displaced = path("preflight-lock");
    let replaced = false;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (!replaced) {
        replaced = true; renameSync(lock, displaced);
        writeFileSync(lock, "FOREIGN_PREFLIGHT", { mode: 0o600 });
      }
      return s.common.fetch(url, init);
    };
    try {
      await expect(kit.applyDeveloperKey({ ...s.common, fetch })).rejects.toMatchObject({ code: "unsafe_session_store" });
      expect(effects(s)).toHaveLength(0);
      expect(readFileSync(lock, "utf8")).toBe("FOREIGN_PREFLIGHT");
    } finally {
      // Exact test-created foreign fixture is moved, never auto-broken by product code.
      if (existsSync(lock)) renameSync(lock, path("retained-foreign-preflight-lock"));
    }
  });

  it("downloads a bounded P-256 PKCS8 key privately, verifies persistence and replays only its receipt", async () => {
    const s = setup("download"); await s.plan();
    const key = pem();
    s.setEffect(async () => {
      expect(statSync(s.output).mode & 0o777).toBe(0o600);
      expect(operations().find(o => o.value.planFile === s.common.planFile)!.value.state).toBe("pending");
      return new Response(key, { headers: { "content-type": "application/octet-stream" } });
    });
    const receipt = await kit.applyDeveloperKey(s.common);
    expect(receipt).toMatchObject({ state: "completed", action: "download", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(readFileSync(s.output, "utf8")).toBe(key);
    expect(effects(s)[0]!.init.method).toBe("GET");
    expect(effects(s)[0]!.url).toBe(`https://developer.apple.com/services-account/QH65B2/account/auth/key/download?teamId=TEAM123456&keyId=${s.key.keyId}`);
    expect(effects(s)[0]!.init.body).toBeUndefined();
    await kit.applyDeveloperKey(s.common); await kit.reconcileDeveloperKey(s.common);
    expect(effects(s)).toHaveLength(1);
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE KEY|NEVER_EXPOSE|\.p8/);
  });

  it.each(["invalid", "oversized", "wrong-curve", "http", "stream"])("leaves download %s explicitly uncertain and unreconstructable", async failure => {
    const s = setup("download"); await s.plan();
    s.setEffect(async () => {
      if (failure === "http") return new Response(secret, { status: 500 });
      if (failure === "stream") return new Response(new ReadableStream({ pull(controller) { controller.error(new Error(secret)); } }));
      const body = failure === "invalid" ? JSON.stringify({ resultCode: 0, secret }) : failure === "oversized" ? "x".repeat(17000) :
        generateKeyPairSync("ec", { namedCurve: "secp384r1", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
      return new Response(body);
    });
    expect(await kit.applyDeveloperKey(s.common)).toMatchObject({ state: "uncertain" });
    expect(await kit.reconcileDeveloperKey(s.common)).toMatchObject({ state: "uncertain" });
    await kit.applyDeveloperKey(s.common);
    expect(effects(s)).toHaveLength(1);
  });

  it("honors an already-expired 15-second deadline before reading a never-ending download body", async () => {
    const s = setup("download"); await s.plan();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      expect(milliseconds).toBe(15_000);
      return controller.signal;
    });
    s.setEffect(async () => {
      controller.abort();
      return new Response(new ReadableStream({ pull() {} }));
    });
    try {
      expect(await kit.applyDeveloperKey(s.common)).toMatchObject({ state: "uncertain" });
      await kit.applyDeveloperKey(s.common);
      expect(effects(s)).toHaveLength(1);
    } finally { timeout.mockRestore(); }
  });

  it.each(["existing", "symlink", "permissive"])("refuses %s output before the one-time request", async kind => {
    const s = setup("download"); await s.plan();
    if (kind === "symlink") symlinkSync(s.common.sessionFile, s.output);
    else writeFileSync(s.output, "UNRELATED", { mode: kind === "permissive" ? 0o644 : 0o600 });
    await expect(kit.applyDeveloperKey(s.common)).rejects.toBeInstanceOf(kit.DeveloperError);
    expect(effects(s)).toHaveLength(0);
    expect(readFileSync(s.output, "utf8")).toBe(kind === "symlink" ? readFileSync(s.common.sessionFile, "utf8") : "UNRELATED");
  });

  it("preserves private recovery material when final download persistence fails", async () => {
    const s = setup("download"); await s.plan();
    const key = pem(); s.setEffect(async () => new Response(key));
    const write = fs.writeFileSync;
    const failure = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (typeof file === "number" && fs.fstatSync(file).ino === statSync(s.output).ino) throw new Error(secret);
      write(file, data, options);
    });
    syncBuiltinESMExports();
    let receipt;
    try { receipt = await kit.applyDeveloperKey(s.common); }
    finally { failure.mockRestore(); syncBuiltinESMExports(); }
    expect(receipt).toMatchObject({ state: "uncertain" });
    const op = operations().find(o => o.value.planFile === s.common.planFile)!;
    expect(statSync(op.value.recoveryFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(op.value.recoveryFile, "utf8")).toBe(key);
    expect(JSON.stringify(receipt)).not.toContain(op.value.recoveryFile);
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE KEY");
    await kit.applyDeveloperKey(s.common);
    expect(effects(s)).toHaveLength(1);
  });

  it("refuses permissive plans and unsupported platforms without credential I/O", async () => {
    const s = setup(); await s.plan(); chmodSync(s.common.planFile, 0o644);
    await expect(kit.applyDeveloperKey(s.common)).rejects.toMatchObject({ code: "unsafe_session_store" });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const fetch = vi.fn(s.common.fetch);
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await expect(kit.applyDeveloperKey({ ...s.common, fetch })).rejects.toMatchObject({ code: "unsupported_platform" });
      await expect(kit.reconcileDeveloperKey({ ...s.common, fetch })).rejects.toMatchObject({ code: "unsupported_platform" });
    } finally { Object.defineProperty(process, "platform", platform); }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sanitizes local directory failures instead of propagating raw filesystem errors", async () => {
    const s = setup();
    const lstat = fs.lstatSync;
    const failure = vi.spyOn(fs, "lstatSync").mockImplementation((file, options) => {
      if (String(file).includes("/developer-operations")) throw new Error(secret);
      return lstat(file, options);
    });
    syncBuiltinESMExports();
    try {
      const error = await s.plan().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(kit.DeveloperError);
      expect(JSON.stringify(error)).not.toContain(secret);
    } finally { failure.mockRestore(); syncBuiltinESMExports(); }
  });

  it("refuses an index whose pending intent vanished instead of treating it as a retry", async () => {
    const s = setup(); await s.plan();
    s.setEffect(async () => { throw new Error(secret); });
    await kit.applyDeveloperKey(s.common);
    const op = operations().find(o => o.value.planFile === s.common.planFile)!;
    const retained = path("retained-pending-intent.json");
    renameSync(op.file, retained);
    try {
      await expect(kit.applyDeveloperKey(s.common)).rejects.toBeInstanceOf(kit.DeveloperError);
      expect(effects(s)).toHaveLength(1);
    } finally { renameSync(retained, op.file); }
  });

  it("releases its own team lock even when cleanup detects a replaced output before effect", async () => {
    const s = setup("download"); await s.plan();
    const lock = join(home, ".apple-distribution-kit", "developer-operations", teamId, "operations.refresh.lock");
    const displaced = path("retained-reserved-output");
    const link = fs.linkSync;
    const failure = vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (String(to).includes("/developer-operations/")) {
        renameSync(s.output, displaced);
        writeFileSync(s.output, "FOREIGN_OUTPUT", { mode: 0o600 });
        throw new Error(secret);
      }
      link(from, to);
    });
    syncBuiltinESMExports();
    try {
      await expect(kit.applyDeveloperKey(s.common)).rejects.toBeInstanceOf(kit.DeveloperError);
      expect(effects(s)).toHaveLength(0);
      expect(readFileSync(s.output, "utf8")).toBe("FOREIGN_OUTPUT");
      expect(existsSync(lock)).toBe(false);
    } finally {
      failure.mockRestore(); syncBuiltinESMExports();
      if (existsSync(lock)) renameSync(lock, path("retained-cleanup-lock"));
    }
  });

  it("never returns injected raw receipt fields from an otherwise valid private record", async () => {
    const s = setup(); await s.plan(); await kit.applyDeveloperKey(s.common);
    const op = operations().find(o => o.value.planFile === s.common.planFile)!;
    const original = readFileSync(op.file, "utf8");
    const raw = JSON.parse(original);
    raw.receipt.privateKey = secret;
    const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) :
      value !== null && typeof value === "object" ? Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)])
      ) : value;
    const { integrity: _integrity, ...contents } = raw;
    raw.integrity = createHash("sha256").update(JSON.stringify(sorted(contents))).digest("hex");
    writeFileSync(op.file, JSON.stringify(raw));
    try { await expect(kit.applyDeveloperKey(s.common)).rejects.toMatchObject({ code: "invalid_operation" }); }
    finally { writeFileSync(op.file, original); }
  });

  it("does not remove a replaced team lock", async () => {
    const s = setup(); await s.plan();
    const lock = join(home, ".apple-distribution-kit", "developer-operations", teamId, "operations.refresh.lock");
    const displaced = path("displaced-lock");
    s.setEffect(async () => {
      renameSync(lock, displaced); writeFileSync(lock, "NEW_OWNER", { mode: 0o600 });
      throw new Error(secret);
    });
    await expect(kit.applyDeveloperKey(s.common)).rejects.toMatchObject({ code: "unsafe_session_store" });
    expect(readFileSync(lock, "utf8")).toBe("NEW_OWNER");
    // Leave the foreign lock intact; this is the final lifecycle test using this team.
  });
});

describe("lifecycle CLI validation", () => {
  it("routes plan/apply/reconcile and never presents uncertainty as successful JSON", async () => {
    // Use another team because the preceding stale/replaced-lock fixture remains intentionally retained.
    const s = setup();
    const cliTeam = "CLI1234567";
    const sessionFile = path("cli-session.json");
    kit.importDeveloperSession({ teamId: cliTeam, sessionFile, input: {
      teamId: cliTeam, cookies: [{ name: "session", value: secret, domain: ".apple.com", path: "/", secure: true, httpOnly: true, expires: -1 }]
    } });
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (String(url).includes("/bundleIds/")) return json({ data: {
        type: "bundleIds", id: primaryAppId, attributes: { identifier: primaryAppIdentifier, seedId: cliTeam }
      } });
      if (String(url).endsWith("/create")) return new Response(secret, { status: 500 });
      return s.common.fetch(url, init);
    };
    let output = "";
    const cli = kit.createCli({ stdout: v => { output += v; }, stderr: v => { output += v; } }, { developer: { fetch } });
    const scope = ["--team-id", cliTeam, "--environment", "test", "--session-file", sessionFile, "--plan-file", s.common.planFile, "--json"];
    expect(await cli(["developer", "keys", "plan", ...scope, "--action", "create", "--key-name", s.key.keyName,
      "--primary-app-id", primaryAppId, "--primary-app-identifier", primaryAppIdentifier])).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ok: true, result: { action: "create" } });
    output = "";
    expect(await cli(["developer", "keys", "apply", ...scope])).toBe(69);
    expect(JSON.parse(output)).toMatchObject({ ok: false, result: { state: "uncertain" } });
    output = "";
    expect(await cli(["developer", "keys", "reconcile", ...scope])).toBe(69);
    expect(JSON.parse(output)).toMatchObject({ ok: false, result: { state: "uncertain" } });
    expect(output).not.toContain(secret);
  });

  it("rejects invalid key with complete required argv and no transport", async () => {
    const fetch = vi.fn(async () => json({ resultCode: 0, keys: [] }));
    let out = "";
    const cli = kit.createCli({ stdout: v => { out += v; }, stderr: v => { out += v; } }, { developer: { fetch } });
    expect(await cli(["developer", "keys", "get", "--key-id", "../create", "--team-id", teamId,
      "--session-file", path("unused-session.json"), "--json"])).toBe(64);
    expect(JSON.parse(out).error.code).toBe("invalid_arguments");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["--action", "create"], ["--action", "revoke"], ["--action", "download"],
    ["--action", "create", "--key-name", "Example", "--key-id", "KEY1234567"],
    ["--action", "revoke", "--key-id", "../create"],
    ["--action", "create", "--key-name", "Example", "--environment", "duplicate"],
    ["--action", "create", "--key-name", "Example", "--unknown", "value"]
  ].map(extra => ({ extra })))("strictly rejects missing/duplicate/unknown/action-incompatible argv %#", async ({ extra }) => {
    const fetch = vi.fn(async () => json({ resultCode: 0, keys: [] }));
    let out = "";
    const cli = kit.createCli({ stdout: v => { out += v; }, stderr: v => { out += v; } }, { developer: { fetch } });
    expect(await cli(["developer", "keys", "plan", "--team-id", teamId, "--environment", "test",
      "--primary-app-id", primaryAppId, "--primary-app-identifier", primaryAppIdentifier,
      "--session-file", path("unused.json"), "--plan-file", path("unused-plan.json"), ...extra, "--json"])).toBe(64);
    expect(JSON.parse(out).error.code).toBe("invalid_arguments");
    expect(fetch).not.toHaveBeenCalled();
  });
});

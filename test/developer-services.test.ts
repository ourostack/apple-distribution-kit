import fs, { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as kit from "../src/index.js";
import { createCli } from "../src/cli-core.js";
import { createDeveloperTransport } from "../src/developer-transport.js";
import { developerTransportUrl } from "../src/developer-session.js";
import { canonical, digest } from "../src/developer-private-operations.js";
import { observedDeveloperService } from "./developer-services-wire-fixture.js";

const home = vi.hoisted(() => `${process.cwd()}/node_modules/.cache/developer-services-${Date.now()}-${process.pid}`);
const authority = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", () => ({ homedir: () => authority.current }));
mkdirSync(home, { recursive: true, mode: 0o700 });
const created = [home];
afterAll(() => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? [join(dir, e.name), ...walk(join(dir, e.name))] : [join(dir, e.name)]);
  writeFileSync(join(home, "resources.json"), JSON.stringify([...created, ...walk(home)], null, 2), { mode: 0o600 });
});
const teamId = "TEAM123456";
const serviceId = "SVC1234567";
const identifier = "org.example.web";
const primaryAppId = "APP1234567";
const primaryAppIdentifier = "org.example.primary";
const secret = "PRIVATE_COOKIE_AND_CSRF";
const domains = ["login.example.org"];
const returnUrls = ["https://login.example.org/Callback%2FExact?x=%2f"];
const desired = { serviceId, identifier, primaryAppId, primaryAppIdentifier, domains, returnUrls };
let sequence = 0;
function file(label: string): string {
  const path = join(home, `${++sequence}-${label}`);
  created.push(path);
  return path;
}
function row(id: string, enabled = true) {
  return { type: "bundleIdCapabilities", id: `${serviceId}_${id}`,
    attributes: { enabled, settings: null, inputs: [] as unknown[] },
    relationships: { capability: { data: { type: "capabilities", id } },
      appConsentBundleId: { data: id === "APPLE_ID_AUTH" ? { type: "bundleIds", id: primaryAppId } : null } } };
}
function parent() {
  const siwa = row("APPLE_ID_AUTH");
  siwa.attributes.inputs = [
    { key: "APPLE_ID_AUTH_WEB_DOMAIN", values: [{ value: "old.example.org" }], limit: 100 },
    { key: "APPLE_ID_AUTH_WEB_RETURN_URL", values: [{ value: "https://old.example.org/callback" }] }
  ];
  const other = row("OTHER", false);
  other.attributes.inputs = [{ key: "OTHER_INPUT", values: [{ value: "retain" }], label: "display" }];
  const third = row("THIRD");
  return { data: { type: "bundleIds", id: serviceId,
    attributes: { name: "Existing web", identifier, seedId: teamId, platform: "SERVICES" },
    relationships: { bundleIdCapabilities: { data: [siwa, other, third].map(r => ({ type: r.type, id: r.id })) } } },
    included: [{ type: "capabilities", id: "DECOY" }, other, siwa, third] };
}
type Parent = ReturnType<typeof parent>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/vnd.api+json", csrf: secret, csrf_ts: "123456789" }
});
function setup() {
  authority.current = file("authority");
  mkdirSync(authority.current, { mode: 0o700 });
  const sessionFile = file("session.json");
  kit.importDeveloperSession({ teamId, sessionFile, input: { teamId, cookies: [{
    name: "session", value: secret, domain: ".apple.com", path: "/", secure: true, httpOnly: true, expires: -1
  }] } });
  const planFile = file("plan.json");
  let current = parent();
  const seen: { url: string; init: RequestInit }[] = [];
  let effect: ((body: any) => Promise<Response>) | undefined;
  let read: (() => Promise<Response>) | undefined;
  const primaries = new Map<string, unknown>([[primaryAppId, { data: { type: "bundleIds", id: primaryAppId,
    attributes: { identifier: primaryAppIdentifier, seedId: teamId } } }]]);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    seen.push({ url: String(input), init: init! });
    if (init!.method === "PATCH") {
      const body = JSON.parse(String(init!.body));
      if (effect) return effect(body);
      current.included = current.included.map(r => {
        if (!r) return r;
        const update = body.data.relationships.bundleIdCapabilities.data.find((v: any) =>
          v.relationships.capability.data.id === r.id.replace(`${serviceId}_`, ""));
        return update ? { ...r, ...update, id: r.id } : r;
      });
      return json({ data: { type: "bundleIds", id: serviceId } });
    }
    const id = new URL(String(input)).pathname.split("/").at(-1)!;
    if (id !== serviceId) return json(primaries.get(id));
    if (read) return read();
    return json(current);
  };
  const scope = { teamId, environment: "test", sessionFile, planFile, fetch };
  const get = () => kit.getDeveloperService({ teamId, sessionFile, serviceId, identifier, fetch });
  const plan = (changes = {}) => kit.planDeveloperService({ ...scope, ...desired, ...changes });
  return { scope, seen, get, plan, current: () => current,
    setCurrent: (p: Parent) => { current = p; }, setPrimary: (p: unknown, id = primaryAppId) => { primaries.set(id, p); },
    setEffect: (f: typeof effect) => { effect = f; }, setRead: (f: typeof read) => { read = f; } };
}
const patches = (s: ReturnType<typeof setup>) => s.seen.filter(r => r.init.method === "PATCH");
const authorityDir = () => join(authority.current, ".apple-distribution-kit", "developer-services-operations", teamId);
function operation() {
  const dir = authorityDir();
  const path = join(dir, readdirSync(dir).find(n => /^[a-f0-9-]{36}\.json$/.test(n))!);
  return { path, value: JSON.parse(readFileSync(path, "utf8")) };
}
function editOperation(mutate: (op: any) => void) {
  const { path, value } = operation();
  mutate(value);
  const { integrity: _integrity, ...contents } = value;
  writeFileSync(path, canonical({ ...contents, integrity: digest(contents) }), { mode: 0o600 });
}
function editPlan(path: string, mutate: (plan: any) => void) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  mutate(raw);
  const { hash: _hash, ...contents } = raw;
  writeFileSync(path, canonical({ ...contents, hash: digest(contents) }), { mode: 0o600 });
}
const cli = async (args: string[], fetch?: typeof globalThis.fetch) => {
  let output = "";
  const code = await createCli({ stdout: s => { output += s; }, stderr: s => { output += s; } },
    { developer: { ...(fetch ? { fetch } : {}) } })(args);
  return { code, output };
};

describe("existing Services ID guarded configuration", () => {
  it("exports resource-bound inspection and lifecycle APIs", () => {
    for (const name of ["getDeveloperService", "planDeveloperService", "applyDeveloperService", "reconcileDeveloperService"]) {
      expect(Reflect.get(kit, name)).toBeTypeOf("function");
    }
    expect(Reflect.get(kit, "createDeveloperTransport")).toBeUndefined();
  });

  it("inspects the exact include graph and separately verifies the primary without leaking raw resources", async () => {
    const s = setup();
    expect(await s.get()).toEqual({ teamId, serviceId, identifier, enabled: true, primaryAppId, primaryAppIdentifier,
      domains: ["old.example.org"], returnUrls: ["https://old.example.org/callback"] });
    expect(s.seen[0]!.url).toBe(`https://developer.apple.com/services-account/v1/bundleIds/${serviceId}?include=bundleIdCapabilities,bundleIdCapabilities.capability,bundleIdCapabilities.appConsentBundleId`);
    expect(s.seen[0]!.init.method).toBe("POST");
    expect(s.seen[0]!.init.headers).toMatchObject({ "content-type": "application/vnd.api+json",
      "X-HTTP-Method-Override": "GET", "X-Requested-With": "XMLHttpRequest" });
    expect(JSON.parse(String(s.seen[0]!.init.body))).toEqual({ teamId });
    expect(s.seen).toHaveLength(2);
    expect(JSON.stringify(await s.get())).not.toContain(secret);
  });

  it("plans without effects then PATCHes the parent with retained capabilities and verifies completion", async () => {
    const s = setup();
    const plan = await s.plan();
    expect(plan).toMatchObject({ version: 1, action: "configure-service", teamId, environment: "test", ...desired, noOp: false });
    expect(patches(s)).toHaveLength(0);
    const receipt = await kit.applyDeveloperService(s.scope);
    expect(receipt).toEqual({ ...plan, state: "completed" });
    const patch = patches(s)[0]!;
    expect(patch.url).toBe(`https://developer.apple.com/services-account/v1/bundleIds/${serviceId}`);
    expect(patch.init.headers).toMatchObject({ "content-type": "application/vnd.api+json",
      "X-Requested-With": "XMLHttpRequest", csrf: secret, csrf_ts: "123456789" });
    expect(patch.init.headers).not.toHaveProperty("X-HTTP-Method-Override");
    const body = JSON.parse(String(patch.init.body));
    expect(body.data.attributes).toEqual({ name: "Existing web", identifier, platform: "SERVICES", seedId: teamId, teamId });
    const rows = body.data.relationships.bundleIdCapabilities.data;
    expect(rows).toContainEqual({ type: "bundleIdCapabilities", attributes: {
      enabled: true, inputs: [
        { key: "APPLE_ID_AUTH_WEB_RETURN_URL", values: [{ value: returnUrls[0] }] },
        { key: "APPLE_ID_AUTH_WEB_DOMAIN", values: [{ value: domains[0] }] }
      ] }, relationships: { capability: { data: { type: "capabilities", id: "APPLE_ID_AUTH" } },
        appConsentBundleId: { data: { type: "bundleIds", id: primaryAppId } } } });
    expect(rows.find((r: any) => r.relationships.capability.data.id === "OTHER")).toMatchObject({
      attributes: { enabled: false, settings: null, inputs: [{ key: "OTHER_INPUT", values: [{ value: "retain" }] }] },
      relationships: { appConsentBundleId: { data: null } }
    });
    const count = s.seen.length;
    expect(await kit.applyDeveloperService(s.scope)).toEqual(receipt);
    expect(await kit.reconcileDeveloperService(s.scope)).toEqual(receipt);
    expect(s.seen).toHaveLength(count);
  });

  it("returns verified no-op without PATCH and keeps a durable completed receipt", async () => {
    const s = setup();
    const p = s.current();
    const siwa = p.included.find(r => r.id.endsWith("_APPLE_ID_AUTH"))! as ReturnType<typeof row>;
    siwa.attributes.inputs = [{ key: "APPLE_ID_AUTH_WEB_DOMAIN", values: [{ value: domains[0] }] },
      { key: "APPLE_ID_AUTH_WEB_RETURN_URL", values: [{ value: returnUrls[0] }] }];
    const plan = await s.plan();
    expect(plan.noOp).toBe(true);
    expect(await kit.applyDeveloperService(s.scope)).toEqual({ ...plan, state: "completed" });
    expect(patches(s)).toHaveLength(0);
  });

  it.each([
    { domains: [] }, { domains: ["Example.org", "example.org"] }, { domains: ["*.example.org"] },
    { domains: ["localhost"] }, { domains: ["127.0.0.1"] }, { domains: ["10.0.0.1"] },
    { domains: ["a.local"] }, { domains: ["a..org"] }, { domains: ["-a.org"] },
    { domains: ["a.org."] }, { domains: ["a.org/path"] }, { domains: ["a.org:443"] },
    { domains: [42] }, { returnUrls: [] }, { returnUrls: [returnUrls[0], returnUrls[0]] },
    { returnUrls: ["http://login.example.org/x"] }, { returnUrls: ["https://user@login.example.org/x"] },
    { returnUrls: ["https://login.example.org/x#fragment"] }, { returnUrls: ["https://other.example.org/x"] },
    { returnUrls: ["https://127.1/x"] }, { returnUrls: ["https://[::1]/x"] }, { returnUrls: ["not a URL"] },
    { returnUrls: ["https://login.example.org/space here"] }, { returnUrls: [null] },
    { returnUrls: ["https://login.example.org:8443/x"] }, { unexpected: "forbidden" },
    { primaryAppIdentifier: `${teamId}.${primaryAppIdentifier}` }, { identifier: "invalid" },
    { environment: "../prod" }, { serviceId: "https://evil.example" }
  ])("rejects unsafe or ambiguous desired input before any request: %j", async changes => {
    const s = setup();
    await expect(s.plan(changes)).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(s.seen).toHaveLength(0);
  });

  it("normalizes domain case and list order but preserves exact callback spelling", async () => {
    const s = setup();
    const p = await s.plan({ domains: ["Z.example.org", "LOGIN.example.org"],
      returnUrls: ["https://z.example.org/z", returnUrls[0]] });
    expect(p.domains).toEqual(["login.example.org", "z.example.org"]);
    expect(p.returnUrls).toEqual([returnUrls[0], "https://z.example.org/z"]);
  });

  it("refuses stale state, tampering and scope changes before PATCH", async () => {
    const s = setup();
    await s.plan();
    s.current().data.attributes.name = "Changed";
    await expect(kit.applyDeveloperService(s.scope)).rejects.toMatchObject({ code: "stale_plan" });
    await expect(kit.applyDeveloperService({ ...s.scope, environment: "production" })).rejects.toMatchObject({ code: "scope_mismatch" });
    await expect(kit.applyDeveloperService({ ...s.scope, teamId: "OTHER12345" })).rejects.toMatchObject({ code: "team_mismatch" });
    const raw = JSON.parse(readFileSync(s.scope.planFile, "utf8"));
    raw.domains = ["attacker.example.org"];
    writeFileSync(s.scope.planFile, JSON.stringify(raw), { mode: 0o600 });
    await expect(kit.applyDeveloperService(s.scope)).rejects.toMatchObject({ code: "invalid_plan" });
    expect(patches(s)).toHaveLength(0);
  });

  it("persists unknown effects across session clones and new plans, and only reconciles read-only", async () => {
    const s = setup();
    await s.plan();
    s.setEffect(async () => { throw new Error(secret); });
    const uncertain = await kit.applyDeveloperService(s.scope);
    expect(uncertain).toMatchObject({ state: "uncertain", errorCode: "network_error" });
    expect(JSON.stringify(uncertain)).not.toContain(secret);
    const clone = file("clone.json");
    copyFileSync(s.scope.sessionFile, clone); chmodSync(clone, 0o600);
    expect(await kit.applyDeveloperService({ ...s.scope, sessionFile: clone })).toEqual(uncertain);
    await expect(s.plan({ planFile: file("new-plan.json"), sessionFile: clone, environment: "prod" }))
      .rejects.toMatchObject({ code: "operation_pending" });
    expect(await kit.reconcileDeveloperService(s.scope)).toMatchObject({ state: "uncertain", errorCode: "resource_mismatch" });
    const r = s.current().included.find(r => r.id.endsWith("_APPLE_ID_AUTH"))! as ReturnType<typeof row>;
    r.attributes.inputs = [{ key: "APPLE_ID_AUTH_WEB_DOMAIN", values: [{ value: domains[0] }] },
      { key: "APPLE_ID_AUTH_WEB_RETURN_URL", values: [{ value: returnUrls[0] }] }];
    expect(await kit.reconcileDeveloperService(s.scope)).toMatchObject({ state: "completed" });
    expect(patches(s)).toHaveLength(1);
  });

  it("cooperative concurrent callers cannot issue a second effect", async () => {
    const s = setup();
    await s.plan();
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const entered = new Promise<void>(r => { started = r; });
    s.setEffect(async () => { started(); await held; throw new Error("unknown"); });
    const running = kit.applyDeveloperService(s.scope);
    await entered;
    await expect(kit.applyDeveloperService(s.scope)).rejects.toMatchObject({ code: "session_store_busy" });
    release();
    expect(await running).toMatchObject({ state: "uncertain" });
    expect(patches(s)).toHaveLength(1);
  });

  it("exposes strict CLI inspection, private config planning, apply and reconcile", async () => {
    const s = setup();
    const config = file("desired.json");
    writeFileSync(config, JSON.stringify(desired), { mode: 0o600 });
    const base = ["--team-id", teamId, "--session-file", s.scope.sessionFile, "--json"];
    const lifecycle = [...base, "--environment", "test", "--plan-file", s.scope.planFile];
    const get = await cli(["developer", "services", "get", ...base, "--service-id", serviceId, "--identifier", identifier], s.scope.fetch);
    expect(get.code).toBe(0);
    expect(JSON.parse(get.output).result).toMatchObject({ serviceId, identifier });
    expect((await cli(["developer", "services", "plan", ...lifecycle, "--config", config], s.scope.fetch)).code).toBe(0);
    expect((await cli(["developer", "services", "apply", ...lifecycle], s.scope.fetch)).code).toBe(0);
    expect((await cli(["developer", "services", "reconcile", ...lifecycle], s.scope.fetch)).code).toBe(0);
    expect(patches(s)).toHaveLength(1);
  });

  it.each([
    ["get", []], ["get", ["--service-id", serviceId]], ["get", ["--identifier", identifier]],
    ["get", ["--service-id", "bad", "--identifier", identifier]],
    ["get", ["--service-id", serviceId, "--identifier", "bad"]],
    ["get", ["--service-id", serviceId, "--identifier", identifier, "--service-id", serviceId]],
    ["get", ["--service-id", serviceId, "--identifier", identifier, "--config", "x"]],
    ["plan", ["--environment", "test", "--plan-file", "plan"]],
    ["plan", ["--environment", "test", "--config", "config"]],
    ["plan", ["--plan-file", "plan", "--config", "config"]],
    ["plan", ["--environment", "../prod", "--plan-file", "plan", "--config", "config"]],
    ["plan", ["--environment", "test", "--plan-file", "plan", "--config"]],
    ["apply", ["--environment", "test", "--plan-file", "plan", "--config", "config"]],
    ["apply", ["--environment", "test"]], ["reconcile", ["--plan-file", "plan"]]
  ] as [string, string[]][])("rejects incomplete/foreign Services CLI argv %s %j before I/O", async (command, extra) => {
    const s = setup();
    const result = await cli(["developer", "services", command, "--team-id", teamId,
      "--session-file", s.scope.sessionFile, "--json", ...extra], s.scope.fetch);
    expect(result.code).toBe(64);
    expect(s.seen).toHaveLength(0);
  });

  it("does not silently let private config override CLI scope or contain unknown fields", async () => {
    const s = setup();
    const config = file("foreign-config.json");
    writeFileSync(config, JSON.stringify({ ...desired, teamId: "OTHER12345" }), { mode: 0o600 });
    const result = await cli(["developer", "services", "plan", "--team-id", teamId, "--session-file", s.scope.sessionFile,
      "--environment", "test", "--plan-file", s.scope.planFile, "--config", config, "--json"], s.scope.fetch);
    expect(result.code).toBe(64);
    expect(s.seen).toHaveLength(0);
  });

  it.each(["https://@login.example.org/x", "https://login.example.org/%fG",
    "https://login.example.org/%0A", "https://login.example.org/x?bad=%", "https://login.example.org\\@evil.org/x",
    "https://%6cogin.example.org/x", "https://login.example.org:/x"])
  ("rejects callback authority/control/escape ambiguities: %s", async url => {
    const s = setup();
    await expect(s.plan({ returnUrls: [url] })).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(s.seen).toHaveLength(0);
  });

  const malformed: [string, (p: any) => void][] = [
    ["parent type", p => { p.data.type = "keys"; }], ["parent ID", p => { p.data.id = "WRONG12345"; }],
    ["identifier", p => { p.data.attributes.identifier = "org.other"; }], ["team", p => { p.data.attributes.seedId = "OTHER12345"; }],
    ["platform", p => { p.data.attributes.platform = "IOS"; }], ["name", p => { p.data.attributes.name = ""; }],
    ["name type", p => { p.data.attributes.name = 42; }], ["long name", p => { p.data.attributes.name = "x".repeat(256); }],
    ["parent attributes", p => { p.data.attributes = null; }], ["parent relationships", p => { p.data.relationships = null; }],
    ["missing capability relation", p => { delete p.data.relationships.bundleIdCapabilities; }],
    ["missing references", p => { p.data.relationships.bundleIdCapabilities.data = null; }],
    ["missing includes", p => { p.included = null; }], ["unknown parent config", p => { p.data.attributes.newSetting = true; }],
    ["unknown relationship", p => { p.data.relationships.newRelationship = {}; }],
    ["unknown linkage fields", p => { p.data.relationships.bundleIdCapabilities.extra = "unknown"; }],
    ["malformed reference", p => { p.data.relationships.bundleIdCapabilities.data[0] = null; }],
    ["foreign reference type", p => { p.data.relationships.bundleIdCapabilities.data[0].type = "keys"; }],
    ["missing reference ID", p => { delete p.data.relationships.bundleIdCapabilities.data[0].id; }],
    ["invalid reference ID", p => { p.data.relationships.bundleIdCapabilities.data[0].id = "../evil"; }],
    ["unknown reference field", p => { p.data.relationships.bundleIdCapabilities.data[0].secret = true; }],
    ["duplicate reference", p => { p.data.relationships.bundleIdCapabilities.data.push(p.data.relationships.bundleIdCapabilities.data[0]); }],
    ["missing exact row", p => { p.included.splice(2, 1); }],
    ["duplicate exact row", p => { p.included.push(p.included[2]); }],
    ["wrong capability ID", p => { p.included[2].relationships.capability.data.id = "OTHER"; }],
    ["cap attributes", p => { p.included[2].attributes = null; }],
    ["cap enabled", p => { p.included[2].attributes.enabled = "yes"; }],
    ["cap relationships", p => { p.included[2].relationships = null; }],
    ["unknown cap attribute", p => { p.included[2].attributes.newSetting = "retain?"; }],
    ["unknown cap relation", p => { p.included[2].relationships.otherBinding = {}; }],
    ["missing capability relation", p => { delete p.included[2].relationships.capability; }],
    ["missing capability data", p => { p.included[2].relationships.capability = {}; }],
    ["unknown relation field", p => { p.included[2].relationships.capability.other = true; }],
    ["cap inputs", p => { p.included[2].attributes.inputs = {}; }],
    ["cap missing inputs", p => { delete p.included[2].attributes.inputs; }],
    ["cap missing input", p => { p.included[2].attributes.inputs.pop(); }],
    ["unknown SIWA input", p => { p.included[2].attributes.inputs[0].key = "UNKNOWN"; }],
    ["malformed input", p => { p.included[2].attributes.inputs[0] = null; }],
    ["input key", p => { p.included[2].attributes.inputs[0].key = 42; }],
    ["duplicate input", p => { p.included[2].attributes.inputs[1] = p.included[2].attributes.inputs[0]; }],
    ["input values", p => { p.included[2].attributes.inputs[0].values = null; }],
    ["unknown input field", p => { p.included[2].attributes.inputs[0].configuration = "unknown"; }],
    ["input value shape", p => { p.included[2].attributes.inputs[0].values = [null]; }],
    ["input value type", p => { p.included[2].attributes.inputs[0].values = [{ value: 42 }]; }],
    ["input value length", p => { p.included[2].attributes.inputs[0].values = [{ value: "x".repeat(4097) }]; }],
    ["input value control", p => { p.included[2].attributes.inputs[0].values = [{ value: "\n" }]; }],
    ["input value unknown", p => { p.included[2].attributes.inputs[0].values = [{ value: "ok", secret: "unexpected" }]; }],
    ["non-null SIWA settings", p => { p.included[2].attributes.settings = []; }],
    ["unrepresentable settings", p => { p.included[1].attributes.settings = { unknown: "do not drop" }; }],
    ["malformed settings", p => { p.included[1].attributes.settings = [null]; }],
    ["settings key", p => { p.included[1].attributes.settings = [{ key: "", options: [] }]; }],
    ["settings options", p => { p.included[1].attributes.settings = [{ key: "KEY", options: null }]; }],
    ["settings unknown", p => { p.included[1].attributes.settings = [{ key: "KEY", options: [], extra: true }]; }],
    ["setting option shape", p => { p.included[1].attributes.settings = [{ key: "KEY", options: [null] }]; }],
    ["setting option key", p => { p.included[1].attributes.settings = [{ key: "KEY", options: [{ key: 42, enabled: true }] }]; }],
    ["setting option flag", p => { p.included[1].attributes.settings = [{ key: "KEY", options: [{ key: "OPT", enabled: 42 }] }]; }],
    ["setting option unknown", p => { p.included[1].attributes.settings = [{ key: "KEY", options: [{ key: "OPT", enabled: true, extra: true }] }]; }],
    ["missing primary relationship", p => { delete p.included[2].relationships.appConsentBundleId; }],
    ["null primary", p => { p.included[2].relationships.appConsentBundleId.data = null; }]
  ];
  it.each(malformed)("refuses unsafe/incomplete parent graph: %s", async (_label, mutate) => {
    const s = setup();
    mutate(s.current());
    await expect(s.get()).rejects.toBeInstanceOf(kit.DeveloperError);
    expect(patches(s)).toHaveLength(0);
  });

  it.each([null, [], {}, { data: null }, { data: {} }])("refuses malformed parent documents %j", async body => {
    const s = setup(); s.setRead(async () => json(body));
    await expect(s.get()).rejects.toMatchObject({ code: "resource_mismatch" });
  });

  it.each([
    null, {}, { data: null }, { data: { type: "keys" } }, { data: { type: "bundleIds", id: "WRONG12345" } },
    { data: { type: "bundleIds", id: primaryAppId } },
    { data: { type: "bundleIds", id: primaryAppId, attributes: { identifier: primaryAppIdentifier, seedId: "OTHER12345" } } },
    { data: { type: "bundleIds", id: primaryAppId, attributes: { identifier: "bad", seedId: teamId } } }
  ])("refuses unscoped primary documents %j", async body => {
    const s = setup(); s.setPrimary(body);
    await expect(s.get()).rejects.toBeInstanceOf(kit.DeveloperError);
  });

  it("checks the declared desired primary identifier before planning", async () => {
    const s = setup();
    await expect(s.plan({ primaryAppIdentifier: "org.different.primary" })).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(existsSync(s.scope.planFile)).toBe(false);
  });

  it("preserves non-null unrelated settings, missing optional fields and exact associations", async () => {
    const s = setup();
    const p: any = s.current();
    p.included[1].attributes.settings = [{ key: "FEATURE", options: [{ key: "OPT", enabled: false }] }];
    p.included[1].relationships.appConsentBundleId.data = { type: "bundleIds", id: "OTHER12345" };
    delete p.included[3].attributes.inputs;
    delete p.included[3].attributes.settings;
    delete p.included[3].relationships.appConsentBundleId;
    delete p.included[2].attributes.settings;
    p.included.push(null, { type: "bundleIds", id: "DECOY" });
    await s.plan();
    expect(await kit.applyDeveloperService(s.scope)).toMatchObject({ state: "completed" });
    const rows = JSON.parse(String(patches(s)[0]!.init.body)).data.relationships.bundleIdCapabilities.data;
    expect(rows.find((r: any) => r.relationships.capability.data.id === "OTHER")).toEqual({
      type: "bundleIdCapabilities", attributes: { enabled: false,
        inputs: [{ key: "OTHER_INPUT", values: [{ value: "retain" }] }],
        settings: [{ key: "FEATURE", options: [{ key: "OPT", enabled: false }] }] },
      relationships: { capability: { data: { type: "capabilities", id: "OTHER" } },
        appConsentBundleId: { data: { type: "bundleIds", id: "OTHER12345" } } }
    });
  });

  it.each([
    ["network", async () => { throw new Error(secret); }, "network_error"],
    ["http", async () => json({}, 500), "http_error"],
    ["body", async () => new Response("not JSON", { headers: { "content-type": "application/json" } }), "invalid_response"],
    ["identity", async () => json({ data: { type: "bundleIds", id: "WRONG12345" } }), "resource_mismatch"],
    ["shape", async () => json({ resultCode: 0 }), "invalid_response"],
    ["agreement", async () => json({ resultCode: 2100 }), "agreement_required"],
    ["unknown code", async () => json({ resultCode: 9999, secret }), "apple_error"],
    ["invalid code", async () => json({ resultCode: "0" }), "invalid_response"],
    ["login", async () => json({}, 401), "sign_in_required"]
  ] as const)("never retries an unknown %s effect", async (_label, effect, errorCode) => {
    const s = setup(); await s.plan(); s.setEffect(effect);
    const r = await kit.applyDeveloperService(s.scope);
    expect(r).toMatchObject({ state: "uncertain", errorCode });
    expect(await kit.applyDeveloperService(s.scope)).toEqual(r);
    expect(patches(s)).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it.each(["unrelated", "no-change", "read-error"])("requires a fresh full postcondition: %s", async kind => {
    const s = setup(); await s.plan();
    s.setEffect(async body => {
      if (kind === "unrelated") {
        const cap = s.current().included[2] as ReturnType<typeof row>;
        const intended = body.data.relationships.bundleIdCapabilities.data.find((r: any) => r.relationships.capability.data.id === "APPLE_ID_AUTH");
        cap.attributes = intended.attributes; cap.relationships = intended.relationships;
        (s.current().included[1] as ReturnType<typeof row>).attributes.enabled = true;
      }
      if (kind === "read-error") s.setRead(async () => { throw new Error(secret); });
      return json({ data: { type: "bundleIds", id: serviceId } });
    });
    expect(await kit.applyDeveloperService(s.scope)).toMatchObject({ state: "uncertain",
      errorCode: kind === "read-error" ? "network_error" : "resource_mismatch" });
    expect(patches(s)).toHaveLength(1);
  });

  it.each([["agreement_required", 2100], ["sign_in_required", 401]] as const)
  ("retains an actual %s manual gate during effect-free reconcile", async (errorCode, value) => {
    const s = setup(); await s.plan(); s.setEffect(async () => { throw new Error(secret); });
    await kit.applyDeveloperService(s.scope);
    s.setRead(async () => value === 401 ? json({}, value) : json({ resultCode: value }));
    const r = await kit.reconcileDeveloperService(s.scope);
    expect(r).toMatchObject({ state: "uncertain", errorCode, requiresHuman: { code:
      value === 401 ? "developer_sign_in_required" : "developer_agreement_required" } });
    const result = await cli(["developer", "services", "reconcile", "--team-id", teamId, "--session-file", s.scope.sessionFile,
      "--environment", "test", "--plan-file", s.scope.planFile, "--json"], s.scope.fetch);
    expect(result.code).toBe(69);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, result: { state: "uncertain", errorCode } });
    expect(patches(s)).toHaveLength(1);
  });

  it("does not accept arbitrary internal transport paths or GET updates", async () => {
    const s = setup();
    const t = createDeveloperTransport({ teamId, session: kit.loadDeveloperSession(s.scope), fetch: s.scope.fetch });
    expect(() => developerTransportUrl("service:../evil" as any)).toThrow(kit.DeveloperError);
    expect(() => developerTransportUrl("service-update:https://evil.org" as any)).toThrow(kit.DeveloperError);
    await expect(t.request(`service-update:${serviceId}`, { method: "GET" })).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(t.request(`service:${serviceId}`, { method: "PATCH" })).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(s.seen).toHaveLength(0);
  });

  it.each(["https://login.example.org:bad/x", "https://login.example.org:99999/x", "https://_.org/x", "https://login.example.org:443/x"])
  ("handles callback parser failures and explicit HTTPS spelling safely: %s", async url => {
    const s = setup();
    if (url.includes(":443")) expect((await s.plan({ returnUrls: [url] })).returnUrls).toEqual([url]);
    else await expect(s.plan({ returnUrls: [url] })).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("uses the default fetch without changing destination contracts", async () => {
    const s = setup();
    vi.stubGlobal("fetch", s.scope.fetch);
    try {
      const { fetch: _fetch, ...scope } = s.scope;
      expect((await kit.planDeveloperService({ ...scope, ...desired })).serviceId).toBe(serviceId);
      expect((await cli(["developer", "services", "get", "--team-id", teamId, "--session-file", scope.sessionFile,
        "--service-id", serviceId, "--identifier", identifier])).code).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(["csrf", "csrf_ts"] as const)("does not PATCH without fresh %s", async missing => {
    const s = setup(); await s.plan();
    s.setRead(async () => {
      const r = json(s.current());
      r.headers.delete(missing);
      return r;
    });
    await expect(kit.applyDeveloperService(s.scope)).rejects.toMatchObject({ code: "invalid_response" });
    expect(patches(s)).toHaveLength(0);
    expect(readdirSync(authorityDir()).filter(n => n.endsWith(".json"))).toHaveLength(0);
  });

  it.each([null, {}, { version: 2 }])("refuses incomplete private plan %j", async value => {
    const s = setup();
    writeFileSync(s.scope.planFile, JSON.stringify(value), { mode: 0o600 });
    await expect(kit.applyDeveloperService(s.scope)).rejects.toMatchObject({ code: "invalid_plan" });
    expect(s.seen).toHaveLength(0);
  });

  it.each(["config", "inconsistent-noop", "postcondition", "unknown-field"])("refuses self-hashed unsafe plan %s", async field => {
    const s = setup(); await s.plan();
    editPlan(s.scope.planFile, raw => {
      if (field === "config") raw.domains = ["localhost"];
      if (field === "inconsistent-noop") raw.noOp = true;
      if (field === "postcondition") raw.postcondition = "a".repeat(64);
      if (field === "unknown-field") raw.privateOverride = secret;
    });
    await expect(kit.applyDeveloperService(s.scope)).rejects.toMatchObject({ code: "invalid_plan" });
    expect(patches(s)).toHaveLength(0);
  });

  it("does not reconcile a plan that never had a durable effect intent", async () => {
    const s = setup(); await s.plan();
    await expect(kit.reconcileDeveloperService(s.scope)).rejects.toMatchObject({ code: "invalid_operation" });
    expect(patches(s)).toHaveLength(0);
  });

  it("retains pending intents without invented errors or implicit retry permission", async () => {
    const s = setup(); await s.plan();
    s.setEffect(async () => { throw new Error(secret); });
    await kit.applyDeveloperService(s.scope);
    editOperation(op => { op.state = "pending"; delete op.receipt; });
    const receipt = await kit.applyDeveloperService(s.scope);
    expect(receipt).toMatchObject({ state: "uncertain" });
    expect(receipt).not.toHaveProperty("errorCode");
    editOperation(op => { op.state = "uncertain"; op.receipt = receipt; });
    expect(await kit.applyDeveloperService(s.scope)).toEqual(receipt);
    await expect(s.plan({ planFile: file("blocked.json") })).rejects.toMatchObject({ code: "operation_pending" });
    expect(patches(s)).toHaveLength(1);
  });

  const corruptions: [string, (op: any) => void][] = [
    ["plan", op => { op.plan = {}; }], ["version", op => { op.version = 2; }],
    ["identity", op => { op.operationId = "invalid"; }], ["hash", op => { op.planHash = "a".repeat(64); }],
    ["resource", op => { op.resource = `service:OTHER12345`; }], ["state", op => { op.state = "absent"; }],
    ["unknown field", op => { op.secret = secret; }],
    ["receipt shape", op => { op.receipt = null; }], ["receipt pending", op => { op.state = "pending"; }],
    ["receipt foreign", op => { op.receipt.serviceId = "OTHER12345"; }],
    ["receipt unknown error", op => { op.state = "uncertain"; op.receipt.state = "uncertain"; op.receipt.errorCode = secret; }],
    ["missing receipt", op => { delete op.receipt; }]
  ];
  it.each(corruptions)("refuses corrupt durable authority: %s", async (_label, mutate) => {
    const s = setup(); await s.plan(); await kit.applyDeveloperService(s.scope);
    editOperation(mutate);
    const before = s.seen.length;
    await expect(kit.applyDeveloperService(s.scope)).rejects.toBeInstanceOf(kit.DeveloperError);
    expect(s.seen).toHaveLength(before);
  });

  it.each(["not-object", "bad-integrity", "missing-index-intent", "wrong-filename", "foreign-team"] as const)
  ("fails closed on authority tampering: %s", async kind => {
    const s = setup(); await s.plan(); await kit.applyDeveloperService(s.scope);
    const op = operation();
    if (kind === "not-object") writeFileSync(op.path, "null", { mode: 0o600 });
    if (kind === "bad-integrity") {
      op.value.integrity = "a".repeat(64);
      writeFileSync(op.path, JSON.stringify(op.value), { mode: 0o600 });
    }
    if (kind === "missing-index-intent" || kind === "wrong-filename") {
      const moved = kind === "wrong-filename" ? join(authorityDir(), "00000000-0000-4000-8000-000000000000.json") : file("retained-intent.json");
      created.push(moved); renameSync(op.path, moved);
    }
    if (kind === "foreign-team") editOperation(raw => {
      raw.plan.teamId = "OTHER12345";
      const { hash: _hash, ...contents } = raw.plan;
      raw.plan.hash = digest(contents);
      raw.planHash = raw.plan.hash;
    });
    await expect(kit.applyDeveloperService(s.scope)).rejects.toMatchObject({ code: "invalid_operation" });
    expect(patches(s)).toHaveLength(1);
  });

  it("rejects an edited plan when its operation identity already exists", async () => {
    const s = setup(); await s.plan(); await kit.applyDeveloperService(s.scope);
    editPlan(s.scope.planFile, raw => { raw.environment = "another"; });
    await expect(kit.applyDeveloperService({ ...s.scope, environment: "another" })).rejects.toMatchObject({ code: "invalid_operation" });
    expect(patches(s)).toHaveLength(1);
  });

  it("retains uncertain authority after post-effect storage failure without a second PATCH", async () => {
    const s = setup(); await s.plan();
    const original = fs.writeFileSync;
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation((path, data, options) => {
      if (typeof data === "string" && data.includes('"state":"completed"')) throw new Error(secret);
      return original(path, data, options);
    });
    syncBuiltinESMExports();
    try {
      const r = await kit.applyDeveloperService(s.scope);
      expect(r).toMatchObject({ state: "uncertain", errorCode: "unsafe_session_store" });
      expect(await kit.applyDeveloperService(s.scope)).toEqual(r);
      expect(patches(s)).toHaveLength(1);
      expect(JSON.stringify(r)).not.toContain(secret);
    } finally { write.mockRestore(); syncBuiltinESMExports(); }
    expect(await kit.reconcileDeveloperService(s.scope)).toMatchObject({ state: "completed" });
    expect(patches(s)).toHaveLength(1);
  });

  it("leaves fsynced pending intent authoritative when all post-effect receipt writes fail", async () => {
    const s = setup(); await s.plan();
    const original = fs.writeFileSync;
    let fail = false;
    s.setEffect(async () => {
      fail = true;
      throw new Error(secret);
    });
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation((path, data, options) => {
      if (fail) throw new Error(secret);
      return original(path, data, options);
    });
    syncBuiltinESMExports();
    try {
      expect(await kit.applyDeveloperService(s.scope)).toMatchObject({ state: "uncertain", errorCode: "network_error" });
    } finally { write.mockRestore(); syncBuiltinESMExports(); }
    expect(operation().value.state).toBe("pending");
    expect(await kit.applyDeveloperService(s.scope)).toMatchObject({ state: "uncertain" });
    expect(patches(s)).toHaveLength(1);
  });

  it.each(["session-symlink", "plan-permissions", "parent-symlink", "foreign-lock"] as const)
  ("uses shared private file and owned-lock guards: %s", async kind => {
    const s = setup();
    if (kind === "session-symlink") {
      const link = file("session-link.json"); symlinkSync(s.scope.sessionFile, link);
      await expect(kit.getDeveloperService({ teamId, serviceId, identifier, sessionFile: link, fetch: s.scope.fetch }))
        .rejects.toMatchObject({ code: "unsafe_session_store" });
    } else if (kind === "plan-permissions") {
      await s.plan(); chmodSync(s.scope.planFile, 0o644);
      await expect(kit.applyDeveloperService(s.scope)).rejects.toMatchObject({ code: "unsafe_session_store" });
    } else if (kind === "parent-symlink") {
      const link = file("linked-directory"); symlinkSync(home, link);
      await expect(s.plan({ planFile: join(link, "plan.json") })).rejects.toMatchObject({ code: "unsafe_session_store" });
    } else {
      await s.plan();
      const lock = join(authorityDir(), "operations.refresh.lock"); created.push(lock);
      writeFileSync(lock, "foreign", { mode: 0o600 });
      await expect(kit.applyDeveloperService(s.scope)).rejects.toMatchObject({ code: "session_store_busy" });
    }
    expect(patches(s)).toHaveLength(0);
  });

  it("rejects non-object private desired config before any transport", async () => {
    const s = setup(); const config = file("null-config.json");
    writeFileSync(config, "null", { mode: 0o600 });
    const result = await cli(["developer", "services", "plan", "--team-id", teamId, "--session-file", s.scope.sessionFile,
      "--environment", "test", "--plan-file", s.scope.planFile, "--config", config, "--json"], s.scope.fetch);
    expect(result.code).toBe(64);
    expect(s.seen).toHaveLength(0);
  });

  it("changes the primary only after separately validating its exact ID, identifier and team", async () => {
    const s = setup();
    const newId = "NEW1234567";
    const newIdentifier = "org.example.newprimary";
    s.setPrimary({ data: { type: "bundleIds", id: newId, attributes: { identifier: newIdentifier, seedId: teamId } } }, newId);
    const plan = await s.plan({ primaryAppId: newId, primaryAppIdentifier: newIdentifier });
    expect(plan.primaryAppId).toBe(newId);
    expect(await kit.applyDeveloperService(s.scope)).toEqual({ ...plan, state: "completed" });
    expect((await s.get()).primaryAppIdentifier).toBe(newIdentifier);
    const newReads = s.seen.filter(r => r.url.includes(`/bundleIds/${newId}?`));
    expect(newReads.length).toBeGreaterThanOrEqual(3);
    expect(newReads.every(r => JSON.parse(String(r.init.body)).teamId === teamId)).toBe(true);
    expect(patches(s)).toHaveLength(1);
  });

  it("enables the existing SIWA capability without changing other capability states", async () => {
    const s = setup();
    (s.current().included[2] as ReturnType<typeof row>).attributes.enabled = false;
    expect((await s.get()).enabled).toBe(false);
    expect((await s.plan()).noOp).toBe(false);
    expect(await kit.applyDeveloperService(s.scope)).toMatchObject({ state: "completed" });
    expect((await s.get()).enabled).toBe(true);
    expect((s.current().included[1] as ReturnType<typeof row>).attributes.enabled).toBe(false);
  });

  it("does not PATCH or remove another owner's replacement lock after an awaited read", async () => {
    const s = setup(); await s.plan();
    const lock = join(authorityDir(), "operations.refresh.lock");
    const displaced = file("retained-acquired-lock");
    let replaced = false;
    s.setRead(async () => {
      if (!replaced) {
        replaced = true;
        renameSync(lock, displaced);
        writeFileSync(lock, "FOREIGN_OWNER", { mode: 0o600 });
      }
      return json(s.current());
    });
    await expect(kit.applyDeveloperService(s.scope)).rejects.toMatchObject({ code: "unsafe_session_store" });
    expect(readFileSync(lock, "utf8")).toBe("FOREIGN_OWNER");
    expect(patches(s)).toHaveLength(0);
  });

  it("preserves agreement gates returned by the primary's JSON API read during reconcile", async () => {
    const s = setup(); await s.plan();
    s.setEffect(async () => { throw new Error(secret); });
    await kit.applyDeveloperService(s.scope);
    s.setPrimary({ resultCode: 2100 });
    expect(await kit.reconcileDeveloperService(s.scope)).toMatchObject({
      state: "uncertain", errorCode: "agreement_required", requiresHuman: { code: "developer_agreement_required" }
    });
    expect(patches(s)).toHaveLength(1);
  });

  it("uses shared private-file semantics for safe paths containing spaces", async () => {
    const s = setup();
    const sessionFile = file("private session.json"); copyFileSync(s.scope.sessionFile, sessionFile); chmodSync(sessionFile, 0o600);
    const planFile = file("private plan.json");
    const plan = await s.plan({ sessionFile, planFile });
    expect(await kit.applyDeveloperService({ ...s.scope, sessionFile, planFile })).toEqual({ ...plan, state: "completed" });
  });

  it("inspects the observed JSON API shape without treating display/navigation metadata as configuration", async () => {
    const s = setup();
    const observed = observedDeveloperService();
    s.setCurrent(observed as unknown as Parent);
    s.setPrimary({ data: observed.included[2] });
    expect(await s.get()).toEqual({ teamId, serviceId, identifier, enabled: true, primaryAppId, primaryAppIdentifier,
      domains: ["login.example.org", "tenant.example.org"],
      returnUrls: [
        "https://login.example.org/account/federation/oauth2",
        "https://login.example.org/tenant.example.org/federation/oauth2",
        "https://login.example.org/tenant/federation/oauth2",
        "https://tenant.example.org/account/federation/oauth2",
        "https://tenant.example.org/tenant.example.org/federation/oauth2"
      ] });
    expect(s.seen).toHaveLength(2);
    const result = await cli(["developer", "services", "get", "--team-id", teamId, "--session-file", s.scope.sessionFile,
      "--service-id", serviceId, "--identifier", identifier, "--json"], s.scope.fetch);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output).result).toMatchObject({ serviceId, primaryAppId });
    expect(result.output).not.toMatch(/responseId|dateModified|relationships|PRIVATE_COOKIE/);
  });

  it("does not stale a valid plan on volatile response metadata, or PATCH navigation/display fields", async () => {
    const s = setup();
    const observed = observedDeveloperService();
    s.setCurrent(observed as unknown as Parent);
    s.setPrimary({ data: observed.included[2] });
    await s.plan();
    observed.data.attributes.responseId = "00000000-0000-4000-8000-000000000002";
    observed.data.attributes.dateModified = "2026-01-03T03:04:05.000+00:00";
    s.setEffect(async body => {
      const cap: any = observed.included[0];
      const update = body.data.relationships.bundleIdCapabilities.data[0];
      Object.assign(cap.attributes, update.attributes);
      Object.assign(cap.relationships, update.relationships);
      cap.attributes.responseId = "00000000-0000-4000-8000-000000000003";
      observed.data.attributes.dateModified = "2026-01-04T03:04:05.000+00:00";
      return json({ data: { type: "bundleIds", id: serviceId } });
    });
    expect(await kit.applyDeveloperService(s.scope)).toMatchObject({ state: "completed" });
    const patch = JSON.parse(String(patches(s)[0]!.init.body));
    expect(patch.data.attributes).toEqual({ name: "Existing web", identifier, seedId: teamId, platform: "SERVICES", teamId });
    expect(JSON.stringify(patch)).not.toMatch(/responseId|dateModified|ownerType|editable|related|paging|profiles/);
  });

  it("plans and applies a verified no-op with the complete observed include graph", async () => {
    const s = setup();
    const observed = observedDeveloperService();
    s.setCurrent(observed as unknown as Parent);
    s.setPrimary({ data: observed.included[2] });
    const desired = await s.get();
    const plan = await s.plan({ domains: desired.domains, returnUrls: desired.returnUrls });
    expect(plan.noOp).toBe(true);
    expect(await kit.applyDeveloperService(s.scope)).toEqual({ ...plan, state: "completed" });
    expect(patches(s)).toHaveLength(0);
  });

  it.each(["parent", "capability"] as const)("refuses unfamiliar actual relationship data on %s", async where => {
    const s = setup();
    const observed: any = observedDeveloperService();
    const relationships = where === "parent" ? observed.data.relationships : observed.included[0].relationships;
    relationships.unfamiliarAssociation = { data: [{ type: "bundleIds", id: "OTHER12345" }],
      links: { related: "https://developer.apple.com/never-follow" } };
    s.setCurrent(observed);
    await expect(s.plan()).rejects.toMatchObject({ code: "invalid_response" });
    expect(patches(s)).toHaveLength(0);
  });

  it.each(["entitlementGroupName", "bundleIdCapabilitiesSettingOption"] as const)
  ("does not silently drop an unsupported non-null parent configuration %s", async field => {
    const s = setup();
    const observed: any = observedDeveloperService();
    observed.data.attributes[field] = { unexpectedConfiguration: true };
    s.setCurrent(observed);
    await expect(s.plan()).rejects.toMatchObject({ code: "invalid_response" });
    expect(patches(s)).toHaveLength(0);
  });

  const invalidMetadata: [string, (p: any) => void][] = [
    ["date shape", p => { p.data.attributes.dateModified = null; }],
    ["notice shape", p => { p.data.attributes.deploymentDataNotice = {}; }],
    ["bundle type", p => { p.data.attributes.bundleType = "another-kind"; }],
    ["wildcard", p => { p.data.attributes.wildcard = true; }],
    ["owner scope", p => { p.included[0].attributes.ownerType = "TEAM"; }],
    ["editability shape", p => { p.included[0].attributes.editable = "yes"; }],
    ["input metadata integer", p => { p.included[0].attributes.inputs[0].minInstances = "1"; }],
    ["input metadata range", p => { p.included[0].attributes.inputs[0].displayOrder = -1; }],
    ["navigation null", p => { p.data.relationships.profiles = null; }],
    ["navigation meta", p => { p.data.relationships.profiles.meta = []; }],
    ["navigation paging", p => { p.data.relationships.profiles.meta.paging = null; }],
    ["navigation unknown metadata", p => { p.data.relationships.profiles.meta.configuration = true; }],
    ["navigation unknown paging", p => { p.data.relationships.profiles.meta.paging.configuration = true; }],
    ["navigation total type", p => { p.data.relationships.profiles.meta.paging.total = "0"; }],
    ["navigation total range", p => { p.data.relationships.profiles.meta.paging.total = -1; }],
    ["navigation limit type", p => { p.data.relationships.profiles.meta.paging.limit = null; }],
    ["navigation limit range", p => { p.data.relationships.profiles.meta.paging.limit = -1; }],
    ["navigation links type", p => { p.data.relationships.profiles.links = []; }],
    ["navigation links empty", p => { p.data.relationships.profiles.links = {}; }],
    ["navigation unknown link", p => { p.data.relationships.profiles.links.configuration = "unexpected"; }],
    ["navigation link type", p => { p.data.relationships.profiles.links.self = {}; }],
    ["required capability data", p => { delete p.included[0].relationships.capability.data; }],
    ["required primary data", p => { delete p.included[0].relationships.appConsentBundleId.data; }],
    ["unfamiliar empty linkage", p => { p.included[0].relationships.appGroups.data = []; }],
    ["unfamiliar null linkage", p => { p.included[0].relationships.appGroups.data = null; }]
  ];
  it.each(invalidMetadata)("still rejects unsafe observed metadata/linkage: %s", async (_label, mutate) => {
    const s = setup();
    const observed = observedDeveloperService();
    mutate(observed);
    s.setCurrent(observed as unknown as Parent);
    await expect(s.plan()).rejects.toMatchObject({ code: "invalid_response" });
    expect(patches(s)).toHaveLength(0);
  });

  it("accepts only validated metadata values without making them configuration preconditions", async () => {
    const s = setup();
    const observed: any = observedDeveloperService();
    observed.data.attributes.deploymentDataNotice = "Display-only notice";
    delete observed.data.relationships.profiles.links;
    observed.included[0].attributes.editable = false;
    const input = observed.included[0].attributes.inputs[0];
    Object.assign(input, { required: true, type: "string", min: 0, max: 100 });
    s.setCurrent(observed);
    s.setPrimary({ data: observed.included[2] });
    expect((await s.get()).serviceId).toBe(serviceId);
    expect(patches(s)).toHaveLength(0);
  });

  it.each(["before", "after"] as const)("retains full unrelated configuration verification with observed metadata: %s", async phase => {
    const s = setup();
    const observed: any = observedDeveloperService();
    const other: any = row("OTHER", false);
    other.attributes.inputs = [{ key: "OTHER_INPUT", values: [{ value: "retain" }] }];
    other.attributes.ownerType = "BUNDLE";
    other.attributes.editable = false;
    other.attributes.responseId = "00000000-0000-4000-8000-000000000001";
    observed.data.relationships.bundleIdCapabilities.data.push({ type: "bundleIdCapabilities", id: other.id });
    observed.included.push(other);
    s.setCurrent(observed);
    s.setPrimary({ data: observed.included[2] });
    await s.plan();
    if (phase === "before") {
      other.attributes.inputs[0].values[0].value = "changed";
      await expect(kit.applyDeveloperService(s.scope)).rejects.toMatchObject({ code: "stale_plan" });
      expect(patches(s)).toHaveLength(0);
    } else {
      s.setEffect(async body => {
        const configured = body.data.relationships.bundleIdCapabilities.data.find((r: any) => r.relationships.capability.data.id === "APPLE_ID_AUTH");
        Object.assign(observed.included[0].attributes, configured.attributes);
        Object.assign(observed.included[0].relationships, configured.relationships);
        other.attributes.inputs[0].values[0].value = "changed";
        return json({ data: { type: "bundleIds", id: serviceId } });
      });
      expect(await kit.applyDeveloperService(s.scope)).toMatchObject({ state: "uncertain", errorCode: "resource_mismatch" });
      expect(patches(s)).toHaveLength(1);
    }
  });

  it.each(["plan", "apply"] as const)("honors an explicit noneditable SIWA capability before an effect: %s", async phase => {
    const s = setup();
    const observed: any = observedDeveloperService();
    s.setCurrent(observed);
    s.setPrimary({ data: observed.included[2] });
    if (phase === "apply") await s.plan();
    observed.included[0].attributes.editable = false;
    if (phase === "plan") await expect(s.plan()).rejects.toMatchObject({ code: "permission_denied" });
    else await expect(kit.applyDeveloperService(s.scope)).rejects.toMatchObject({ code: "permission_denied" });
    expect(patches(s)).toHaveLength(0);
    expect(readdirSync(authorityDir()).filter(n => n.endsWith(".json"))).toHaveLength(0);
  });

  it("allows read-only inspection and verified no-op even when SIWA is not editable", async () => {
    const s = setup();
    const observed: any = observedDeveloperService();
    observed.included[0].attributes.editable = false;
    s.setCurrent(observed);
    s.setPrimary({ data: observed.included[2] });
    const current = await s.get();
    const plan = await s.plan({ domains: current.domains, returnUrls: current.returnUrls });
    expect(plan.noOp).toBe(true);
    expect(await kit.applyDeveloperService(s.scope)).toMatchObject({ state: "completed", noOp: true });
    expect(patches(s)).toHaveLength(0);
  });

  it("does not ignore navigation metadata that explicitly reports unexpanded associated resources", async () => {
    const s = setup();
    const observed: any = observedDeveloperService();
    observed.included[0].relationships.appGroups.meta.paging.total = 1;
    s.setCurrent(observed);
    s.setPrimary({ data: observed.included[2] });
    await expect(s.plan()).rejects.toMatchObject({ code: "invalid_response" });
    expect(patches(s)).toHaveLength(0);
  });

  it.each(["plan", "apply"] as const)("T3-R1 refuses explicitly partial authoritative capability linkage before %s", async phase => {
    const s = setup();
    const observed = observedDeveloperService();
    s.setCurrent(observed as unknown as Parent);
    s.setPrimary({ data: observed.included[2] });
    if (phase === "apply") await s.plan();
    observed.data.relationships.bundleIdCapabilities.meta!.paging = { total: 2, limit: 1 };
    if (phase === "plan") await expect(s.plan()).rejects.toMatchObject({ code: "invalid_response" });
    else await expect(kit.applyDeveloperService(s.scope)).rejects.toMatchObject({ code: "invalid_response" });
    expect(patches(s)).toHaveLength(0);
    expect(readdirSync(authorityDir()).filter(n => n.endsWith(".json"))).toHaveLength(0);
    if (phase === "plan") expect(existsSync(s.scope.planFile)).toBe(false);
  });

  it("T3-R1 retains uncertainty when a correct effect is followed by explicitly partial capability linkage", async () => {
    const s = setup();
    const observed: any = observedDeveloperService();
    s.setCurrent(observed);
    s.setPrimary({ data: observed.included[2] });
    await s.plan();
    s.setEffect(async body => {
      const configured = body.data.relationships.bundleIdCapabilities.data[0];
      Object.assign(observed.included[0].attributes, configured.attributes);
      Object.assign(observed.included[0].relationships, configured.relationships);
      observed.data.relationships.bundleIdCapabilities.meta.paging = { total: 2, limit: 1 };
      return json({ data: { type: "bundleIds", id: serviceId } });
    });
    const receipt = await kit.applyDeveloperService(s.scope);
    expect(receipt).toMatchObject({ state: "uncertain", errorCode: "invalid_response" });
    expect(operation().value.state).toBe("uncertain");
    expect(await kit.applyDeveloperService(s.scope)).toEqual(receipt);
    expect(await kit.reconcileDeveloperService(s.scope)).toMatchObject({ state: "uncertain", errorCode: "invalid_response" });
    expect(patches(s)).toHaveLength(1);
    observed.data.relationships.bundleIdCapabilities.meta!.paging = { total: 1, limit: 1 };
    expect(await kit.reconcileDeveloperService(s.scope)).toMatchObject({ state: "completed" });
    expect(patches(s)).toHaveLength(1);
  });

  it("T3-R1 permits an explicitly complete positive capability count as well as the attested zero sentinel", async () => {
    const s = setup();
    const observed = observedDeveloperService();
    observed.data.relationships.bundleIdCapabilities.meta!.paging = { total: 1, limit: 1 };
    s.setCurrent(observed as unknown as Parent);
    s.setPrimary({ data: observed.included[2] });
    await s.plan();
    expect(await kit.applyDeveloperService(s.scope)).toMatchObject({ state: "completed" });
    expect(patches(s)).toHaveLength(1);
  });

  function breakFakeSession(sessionFile: string, kind: string) {
    if (kind === "missing") renameSync(sessionFile, file("retained-fabricated-session.json"));
    else if (kind === "malformed") writeFileSync(sessionFile, "{", { mode: 0o600 });
    else if (kind === "unsafe") chmodSync(sessionFile, 0o644);
    else if (kind === "schema") writeFileSync(sessionFile, JSON.stringify({ teamId, version: 99, jar: {} }), { mode: 0o600 });
    else writeFileSync(sessionFile, JSON.stringify({ teamId: "OTHER12345", version: 1, jar: {} }), { mode: 0o600 });
  }

  it.each([
    ["missing", "invalid_session"], ["malformed", "invalid_session"], ["unsafe", "unsafe_session_store"],
    ["schema", "invalid_session"], ["wrong-team", "team_mismatch"]
  ] as const)("T3-R2 preserves and replays pending-intent uncertainty for %s fabricated session storage", async (kind, errorCode) => {
    const s = setup();
    const planned = await s.plan();
    const backup = file("fabricated-session-backup.json");
    copyFileSync(s.scope.sessionFile, backup); chmodSync(backup, 0o600);
    let intent = "";
    s.setEffect(async body => {
      const configured = body.data.relationships.bundleIdCapabilities.data.find((r: any) => r.relationships.capability.data.id === "APPLE_ID_AUTH");
      const cap = s.current().included[2] as ReturnType<typeof row>;
      Object.assign(cap.attributes, configured.attributes);
      Object.assign(cap.relationships, configured.relationships);
      intent = operation().path;
      chmodSync(intent, 0o644);
      throw new Error(secret);
    });
    try {
      expect(await kit.applyDeveloperService(s.scope)).toMatchObject({ state: "uncertain", errorCode: "network_error" });
    } finally { if (intent) chmodSync(intent, 0o600); }
    expect(operation().value.state).toBe("pending");
    expect(operation().value.receipt).toBeUndefined();
    breakFakeSession(s.scope.sessionFile, kind);
    const requestCount = s.seen.length;
    const receipt = await kit.reconcileDeveloperService(s.scope);
    expect(receipt).toEqual({ ...planned, state: "uncertain", errorCode });
    expect(receipt).not.toHaveProperty("requiresHuman");
    expect(operation().value.receipt).toEqual(receipt);
    expect(await kit.applyDeveloperService(s.scope)).toEqual(receipt);
    expect(await kit.reconcileDeveloperService(s.scope)).toEqual(receipt);
    const result = await cli(["developer", "services", "reconcile", "--team-id", teamId, "--session-file", s.scope.sessionFile,
      "--environment", "test", "--plan-file", s.scope.planFile, "--json"], s.scope.fetch);
    expect(result.code).toBe(69);
    expect(JSON.parse(result.output)).toEqual({ ok: false, result: receipt });
    expect(result.output).not.toContain(secret);
    expect(result.output).not.toContain(s.scope.sessionFile);
    expect(s.seen).toHaveLength(requestCount);
    copyFileSync(backup, s.scope.sessionFile); chmodSync(s.scope.sessionFile, 0o600);
    expect(await kit.reconcileDeveloperService(s.scope)).toEqual({ ...planned, state: "completed" });
    expect(patches(s)).toHaveLength(1);
  });

  it.each([
    ["missing", "invalid_session"], ["malformed", "invalid_session"], ["unsafe", "unsafe_session_store"]
  ] as const)("T3-R2 retains ordinary pre-intent refusal for %s fabricated session storage", async (kind, code) => {
    const s = setup(); await s.plan();
    breakFakeSession(s.scope.sessionFile, kind);
    const requestCount = s.seen.length;
    await expect(kit.applyDeveloperService(s.scope)).rejects.toMatchObject({ code });
    const result = await cli(["developer", "services", "apply", "--team-id", teamId, "--session-file", s.scope.sessionFile,
      "--environment", "test", "--plan-file", s.scope.planFile, "--json"], s.scope.fetch);
    expect(result.code).toBe(69);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, error: { code } });
    expect(JSON.parse(result.output)).not.toHaveProperty("result");
    expect(s.seen).toHaveLength(requestCount);
    expect(patches(s)).toHaveLength(0);
    expect(readdirSync(authorityDir()).filter(n => n.endsWith(".json"))).toHaveLength(0);
  });

  it("T3-R2 admits invalid_session only as a validated string receipt code", async () => {
    const s = setup(); await s.plan();
    s.setEffect(async () => { throw new Error(secret); });
    await kit.applyDeveloperService(s.scope);
    editOperation(op => { op.receipt.errorCode = ["invalid_session"]; });
    const requests = s.seen.length;
    await expect(kit.applyDeveloperService(s.scope)).rejects.toMatchObject({ code: "invalid_operation" });
    expect(s.seen).toHaveLength(requests);
    expect(patches(s)).toHaveLength(1);
  });
});

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  acquireDeveloperPrivateLock, assertDeveloperPlatform, DeveloperError, loadDeveloperSession,
  readDeveloperPrivateInput, releaseDeveloperPrivateLock, validateDeveloperId,
  verifyDeveloperPrivateLock, writeDeveloperPrivateStore
} from "./developer-session.js";
import { createDeveloperTransport, developerRecord as record, type DeveloperTransport } from "./developer-transport.js";
import { allOperations, canonical, digest, directory, safeBoundary, saveOperation, uuid, validHash } from "./developer-private-operations.js";
import type { RequiresHuman } from "./plan.js";

const SIWA = "APPLE_ID_AUTH";
const DOMAIN = "APPLE_ID_AUTH_WEB_DOMAIN";
const RETURN = "APPLE_ID_AUTH_WEB_RETURN_URL";
export interface DeveloperServiceGetOptions {
  teamId: string;
  sessionFile: string;
  serviceId: string;
  identifier: string;
  fetch?: typeof globalThis.fetch;
}
export interface DeveloperServiceScope {
  teamId: string;
  environment: string;
  sessionFile: string;
  planFile: string;
  fetch?: typeof globalThis.fetch;
}
export interface DeveloperServiceConfiguration {
  serviceId: string;
  identifier: string;
  primaryAppId: string;
  primaryAppIdentifier: string;
  domains: string[];
  returnUrls: string[];
}
export type DeveloperServicePlanOptions = DeveloperServiceScope & DeveloperServiceConfiguration;
export interface DeveloperServiceSummary extends DeveloperServiceConfiguration {
  teamId: string;
  enabled: boolean;
}
export interface DeveloperServicePlanSummary extends DeveloperServiceConfiguration {
  version: 1;
  action: "configure-service";
  operationId: string;
  teamId: string;
  environment: string;
  planHash: string;
  noOp: boolean;
}
export interface DeveloperServiceReceipt extends DeveloperServicePlanSummary {
  state: "completed" | "uncertain";
  errorCode?: DeveloperError["code"];
  requiresHuman?: RequiresHuman;
}
interface Plan extends DeveloperServiceConfiguration {
  version: 1;
  action: "configure-service";
  operationId: string;
  teamId: string;
  environment: string;
  fingerprint: string;
  postcondition: string;
  noOp: boolean;
  hash: string;
}
interface Operation {
  version: 1;
  operationId: string;
  resource: string;
  planHash: string;
  plan: Plan;
  state: "pending" | "completed" | "uncertain";
  receipt?: DeveloperServiceReceipt;
  integrity: string;
}
interface Link { type: string; id: string }
interface Input { key: string; values: { value: string }[] }
interface Capability {
  type: "bundleIdCapabilities";
  attributes: { enabled: boolean; inputs?: Input[]; settings?: unknown };
  relationships: { capability: { data: Link }; appConsentBundleId?: { data: Link | null } };
}
interface Snapshot {
  type: "bundleIds";
  id: string;
  attributes: { name: string; identifier: string; seedId: string; platform: "SERVICES" };
  relationships: { bundleIdCapabilities: { data: Capability[] } };
}
const scopeFields = ["teamId", "environment", "sessionFile", "planFile", "fetch"];
const configFields = ["serviceId", "identifier", "primaryAppId", "primaryAppIdentifier", "domains", "returnUrls"];
function text(v: unknown, max = 4096): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
}
function keys(v: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new DeveloperError("invalid_response");
}
function exact(v: object, allowed: string[]): void {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new DeveloperError("invalid_arguments");
}
function identifierValue(v: unknown, teamId: string): asserts v is string {
  if (!text(v, 255) || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(v) || v.startsWith(`${teamId}.`)) {
    throw new DeveloperError("invalid_arguments");
  }
}
function scope(options: DeveloperServiceScope): void {
  assertDeveloperPlatform();
  validateDeveloperId(options.teamId);
  if (!text(options.environment, 64) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.environment) ||
    !text(options.sessionFile) || !text(options.planFile)) throw new DeveloperError("invalid_arguments");
}
function hostname(value: string): boolean {
  return value.length <= 253 && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(value) &&
    value.split(".").every(label => label.length <= 63 && !label.startsWith("-") && !label.endsWith("-")) &&
    /[a-z]/.test(value.split(".").at(-1)!) &&
    !/\.(?:localhost|local|internal|lan|home|test|invalid)$/.test(value);
}
function lists(domains: unknown, urls: unknown): { domains: string[]; returnUrls: string[] } {
  if (!Array.isArray(domains) || !domains.length || domains.length > 100 ||
    !Array.isArray(urls) || !urls.length || urls.length > 100) throw new DeveloperError("invalid_arguments");
  const d: string[] = [];
  for (const item of domains) {
    if (typeof item !== "string" || !hostname(item.toLowerCase())) throw new DeveloperError("invalid_arguments");
    d.push(item.toLowerCase());
  }
  const u: string[] = [];
  for (const item of urls) {
    if (!text(item) || /[\\#\s]/.test(item) || !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:[/?]|$)/.test(item)) throw new DeveloperError("invalid_arguments");
    let url: URL;
    try { url = new URL(item); } catch { throw new DeveloperError("invalid_arguments"); }
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !hostname(url.hostname) || !d.includes(url.hostname) ||
      /%(?![a-fA-F0-9]{2})|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(item)) throw new DeveloperError("invalid_arguments");
    u.push(item);
  }
  if (new Set(d).size !== d.length || new Set(u).size !== u.length) throw new DeveloperError("invalid_arguments");
  return { domains: d.sort(), returnUrls: u.sort() };
}
function configuration(options: DeveloperServiceConfiguration, teamId: string): DeveloperServiceConfiguration {
  validateDeveloperId(options.serviceId); validateDeveloperId(options.primaryAppId);
  identifierValue(options.identifier, teamId); identifierValue(options.primaryAppIdentifier, teamId);
  return { serviceId: options.serviceId, identifier: options.identifier, primaryAppId: options.primaryAppId,
    primaryAppIdentifier: options.primaryAppIdentifier, ...lists(options.domains, options.returnUrls) };
}
function transport(options: { teamId: string; sessionFile: string; fetch?: typeof globalThis.fetch }): DeveloperTransport {
  return createDeveloperTransport({ teamId: options.teamId, session: loadDeveloperSession(options),
    ...(options.fetch ? { fetch: options.fetch } : {}) });
}
function link(value: unknown, type: string): Link {
  if (!record(value) || value.type !== type || !text(value.id, 128) || !/^[A-Za-z0-9_]+$/.test(value.id)) {
    throw new DeveloperError("invalid_response");
  }
  keys(value, ["type", "id"]);
  return { type, id: value.id };
}
function relation(value: unknown, type: string, nullable = false): { data: Link | null } {
  if (!record(value)) throw new DeveloperError("invalid_response");
  keys(value, ["data", "links"]);
  return { data: nullable && value.data === null ? null : link(value.data, type) };
}
function inputs(value: unknown): Input[] {
  if (!Array.isArray(value)) throw new DeveloperError("invalid_response");
  const seen = new Set<string>();
  return value.map(v => {
    if (!record(v) || !text(v.key, 128) || seen.has(v.key) || !Array.isArray(v.values)) throw new DeveloperError("invalid_response");
    keys(v, ["key", "values", "name", "label", "description", "limit", "min", "max", "required", "type"]);
    seen.add(v.key);
    return { key: v.key, values: v.values.map(item => {
      if (!record(item) || typeof item.value !== "string" || item.value.length > 4096 || /[\x00-\x1f\x7f]/.test(item.value)) {
        throw new DeveloperError("invalid_response");
      }
      keys(item, ["value"]);
      return { value: item.value };
    }) };
  });
}
function settings(value: unknown): unknown {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new DeveloperError("invalid_response");
  return value.map(v => {
    if (!record(v) || !text(v.key, 128) || !Array.isArray(v.options)) throw new DeveloperError("invalid_response");
    keys(v, ["key", "options"]);
    return { key: v.key, options: v.options.map(o => {
      if (!record(o) || !text(o.key, 128) || typeof o.enabled !== "boolean") throw new DeveloperError("invalid_response");
      keys(o, ["key", "enabled"]);
      return { key: o.key, enabled: o.enabled };
    }) };
  });
}
function capability(raw: unknown, id: string): Capability {
  if (!record(raw) || raw.type !== "bundleIdCapabilities" || raw.id !== id ||
    !record(raw.attributes) || typeof raw.attributes.enabled !== "boolean" || !record(raw.relationships)) {
    throw new DeveloperError("invalid_response");
  }
  keys(raw, ["type", "id", "attributes", "relationships", "links"]);
  keys(raw.attributes, ["enabled", "inputs", "settings"]);
  keys(raw.relationships, ["capability", "appConsentBundleId"]);
  const cap = relation(raw.relationships.capability, "capabilities").data!;
  const result: Capability = { type: "bundleIdCapabilities", attributes: { enabled: raw.attributes.enabled,
    ...(raw.attributes.inputs === undefined ? {} : { inputs: inputs(raw.attributes.inputs) }),
    ...(raw.attributes.settings === undefined ? {} : { settings: settings(raw.attributes.settings) }) },
    relationships: { capability: { data: cap },
      ...(raw.relationships.appConsentBundleId === undefined ? {} :
        { appConsentBundleId: relation(raw.relationships.appConsentBundleId, "bundleIds", true) }) } };
  return result;
}
function siwa(snapshot: Snapshot): Capability {
  return snapshot.relationships.bundleIdCapabilities.data.find(r => r.relationships.capability.data.id === SIWA)!;
}
function listValues(cap: Capability, key: string): string[] {
  return cap.attributes.inputs!.find(i => i.key === key)!.values.map(v => v.value).sort();
}
async function primaryRead(t: DeveloperTransport, teamId: string, id: string, expected?: string): Promise<string> {
  validateDeveloperId(id);
  const r = await t.request(`bundle:${id}`, { json: { teamId } });
  const b = record(r.data) && r.data.data;
  if (!record(b) || b.type !== "bundleIds" || b.id !== id || !record(b.attributes) ||
    b.attributes.seedId !== teamId || (expected !== undefined && b.attributes.identifier !== expected)) {
    throw new DeveloperError("resource_mismatch");
  }
  identifierValue(b.attributes.identifier, teamId);
  r.accept();
  return b.attributes.identifier;
}
async function read(t: DeveloperTransport, options: { teamId: string; serviceId: string; identifier: string }): Promise<{
  snapshot: Snapshot; summary: DeveloperServiceSummary; csrf: { csrf: string; csrf_ts: string };
}> {
  const response = await t.request(`service:${options.serviceId}`, { json: { teamId: options.teamId } });
  const raw = response.data;
  const b = record(raw) && raw.data;
  if (!record(raw) || !record(b) || b.type !== "bundleIds" || b.id !== options.serviceId || !record(b.attributes) ||
    b.attributes.identifier !== options.identifier || b.attributes.seedId !== options.teamId || b.attributes.platform !== "SERVICES" ||
    typeof b.attributes.name !== "string" || !b.attributes.name || b.attributes.name.length > 255 ||
    !record(b.relationships) || !record(b.relationships.bundleIdCapabilities) ||
    !Array.isArray(b.relationships.bundleIdCapabilities.data) || !Array.isArray(raw.included)) throw new DeveloperError("resource_mismatch");
  keys(b, ["type", "id", "attributes", "relationships", "links"]);
  keys(b.attributes, ["name", "identifier", "seedId", "platform"]);
  keys(b.relationships, ["bundleIdCapabilities"]);
  keys(b.relationships.bundleIdCapabilities, ["data", "links"]);
  const ids = new Set<string>();
  const included = raw.included;
  const caps = b.relationships.bundleIdCapabilities.data.map(ref => {
    const identity = link(ref, "bundleIdCapabilities");
    if (ids.has(identity.id)) throw new DeveloperError("invalid_response");
    ids.add(identity.id);
    const rows = included.filter(v => record(v) && v.type === "bundleIdCapabilities" && v.id === identity.id);
    if (rows.length !== 1) throw new DeveloperError("invalid_response");
    const cap = capability(rows[0], identity.id);
    if (identity.id !== `${options.serviceId}_${cap.relationships.capability.data.id}`) throw new DeveloperError("resource_mismatch");
    return cap;
  }).sort((a, b) => a.relationships.capability.data.id.localeCompare(b.relationships.capability.data.id));
  const snapshot: Snapshot = { type: "bundleIds", id: options.serviceId,
    attributes: { name: b.attributes.name, identifier: options.identifier, seedId: options.teamId, platform: "SERVICES" },
    relationships: { bundleIdCapabilities: { data: caps } } };
  const cap = siwa(snapshot);
  if (!cap || !cap.attributes.inputs || cap.attributes.inputs.length !== 2 ||
    ![DOMAIN, RETURN].every(k => cap.attributes.inputs!.some(i => i.key === k)) ||
    (cap.attributes.settings !== undefined && cap.attributes.settings !== null) ||
    !cap.relationships.appConsentBundleId?.data) throw new DeveloperError("invalid_response");
  const primaryAppId = cap.relationships.appConsentBundleId.data.id;
  const primaryAppIdentifier = await primaryRead(t, options.teamId, primaryAppId);
  response.accept();
  return { snapshot, summary: { teamId: options.teamId, serviceId: options.serviceId, identifier: options.identifier,
    enabled: cap.attributes.enabled, primaryAppId, primaryAppIdentifier,
    domains: listValues(cap, DOMAIN), returnUrls: listValues(cap, RETURN) },
    csrf: { csrf: response.headers.get("csrf") ?? "", csrf_ts: response.headers.get("csrf_ts") ?? "" } };
}
function target(snapshot: Snapshot, config: DeveloperServiceConfiguration): Snapshot {
  return { ...snapshot, relationships: { bundleIdCapabilities: { data: snapshot.relationships.bundleIdCapabilities.data.map(cap =>
    cap.relationships.capability.data.id !== SIWA ? cap : { type: "bundleIdCapabilities", attributes: { enabled: true,
      inputs: [{ key: RETURN, values: config.returnUrls.map(value => ({ value })) },
        { key: DOMAIN, values: config.domains.map(value => ({ value })) }] },
      relationships: { capability: { data: { type: "capabilities", id: SIWA } },
        appConsentBundleId: { data: { type: "bundleIds", id: config.primaryAppId } } } }) } } };
}
// Null/absent SIWA settings and input order are presentation differences, not configuration changes.
function fingerprint(snapshot: Snapshot): string {
  const cap = siwa(snapshot);
  const normalized = target(snapshot, { serviceId: snapshot.id, identifier: snapshot.attributes.identifier,
    primaryAppId: cap.relationships.appConsentBundleId!.data!.id, primaryAppIdentifier: "",
    domains: listValues(cap, DOMAIN), returnUrls: listValues(cap, RETURN) });
  siwa(normalized).attributes.enabled = cap.attributes.enabled;
  return digest(normalized);
}
function summary(plan: Plan): DeveloperServicePlanSummary {
  return { version: 1, action: plan.action, operationId: plan.operationId, teamId: plan.teamId, environment: plan.environment,
    serviceId: plan.serviceId, identifier: plan.identifier, primaryAppId: plan.primaryAppId, primaryAppIdentifier: plan.primaryAppIdentifier,
    domains: plan.domains, returnUrls: plan.returnUrls, noOp: plan.noOp, planHash: plan.hash };
}
function uncertain(plan: Plan, error?: unknown): DeveloperServiceReceipt {
  const base: DeveloperServiceReceipt = { ...summary(plan), state: "uncertain" };
  if (error === undefined) return base;
  const safe = error instanceof DeveloperError ? error : new DeveloperError("unsafe_session_store");
  return { ...base, errorCode: safe.code, ...(safe.requiresHuman ? { requiresHuman: safe.requiresHuman } : {}) };
}
function validatePlan(raw: unknown): Plan {
  try {
    if (!record(raw) || raw.version !== 1 || raw.action !== "configure-service" || !uuid(raw.operationId) ||
      !validHash(raw.hash) || !validHash(raw.fingerprint) || !validHash(raw.postcondition) || typeof raw.noOp !== "boolean") {
      throw new DeveloperError("invalid_plan");
    }
    scope({ teamId: raw.teamId as string, environment: raw.environment as string, sessionFile: "private", planFile: "private" });
    const config = configuration(raw as unknown as DeveloperServiceConfiguration, raw.teamId as string);
    const contents = { version: 1 as const, action: "configure-service" as const, operationId: raw.operationId,
      teamId: raw.teamId as string, environment: raw.environment as string, ...config,
      fingerprint: raw.fingerprint, postcondition: raw.postcondition, noOp: raw.noOp };
    const plan = { ...contents, hash: digest(contents) };
    if (canonical(raw) !== canonical(plan) || plan.noOp !== (plan.fingerprint === plan.postcondition)) throw new DeveloperError("invalid_plan");
    return plan;
  } catch { throw new DeveloperError("invalid_plan"); }
}
function readPlan(options: DeveloperServiceScope): Plan {
  const plan = validatePlan(readDeveloperPrivateInput(options.planFile));
  if (plan.teamId !== options.teamId) throw new DeveloperError("team_mismatch");
  if (plan.environment !== options.environment) throw new DeveloperError("scope_mismatch");
  return plan;
}
function operations(dir: string, teamId: string): Operation[] {
  return allOperations(dir, file => {
    const raw = readDeveloperPrivateInput(file);
    if (!record(raw)) throw new DeveloperError("invalid_operation");
    const { integrity, ...contents } = raw;
    if (digest(contents) !== integrity) throw new DeveloperError("invalid_operation");
    let plan: Plan;
    try { plan = validatePlan(raw.plan); } catch { throw new DeveloperError("invalid_operation"); }
    if (raw.version !== 1 || raw.operationId !== plan.operationId || raw.planHash !== plan.hash ||
      raw.resource !== `service:${plan.serviceId}` || plan.teamId !== teamId ||
      file !== join(dir, `${plan.operationId}.json`) || !["pending", "completed", "uncertain"].includes(String(raw.state))) {
      throw new DeveloperError("invalid_operation");
    }
    keys(raw, ["version", "operationId", "resource", "planHash", "plan", "state", "receipt", "integrity"]);
    if (raw.receipt !== undefined) {
      const r = raw.receipt;
      if (!record(r) || (raw.state !== "completed" && raw.state !== "uncertain")) throw new DeveloperError("invalid_operation");
      const code = r.errorCode;
      // Persisted receipts may only express errors this workflow can produce after intent.
      if (code !== undefined && !["network_error", "http_error", "invalid_response", "redirect_rejected", "permission_denied",
        "sign_in_required", "session_expired", "agreement_required", "apple_error", "resource_mismatch", "invalid_arguments",
        "unsafe_session_store", "session_store_busy", "team_mismatch"].includes(String(code))) throw new DeveloperError("invalid_operation");
      const expected = raw.state === "completed" ? { ...summary(plan), state: "completed" } :
        uncertain(plan, code === undefined ? undefined : new DeveloperError(code as DeveloperError["code"]));
      if (canonical(r) !== canonical(expected)) throw new DeveloperError("invalid_operation");
    } else if (raw.state !== "pending") throw new DeveloperError("invalid_operation");
    return raw as unknown as Operation;
  });
}
function checkPending(ops: Operation[], serviceId: string): void {
  if (ops.some(op => op.resource === `service:${serviceId}` && op.state !== "completed")) throw new DeveloperError("operation_pending");
}
async function withLock<T>(options: DeveloperServiceScope, run: (dir: string, verify: () => void) => Promise<T>): Promise<T> {
  const dir = directory(options.teamId, "developer-services-operations");
  const lock = acquireDeveloperPrivateLock(join(dir, "operations"));
  try { return await run(dir, () => verifyDeveloperPrivateLock(lock)); }
  finally { releaseDeveloperPrivateLock(lock); }
}
export function getDeveloperService(options: DeveloperServiceGetOptions): Promise<DeveloperServiceSummary> {
  return safeBoundary(async () => {
    assertDeveloperPlatform(); validateDeveloperId(options.teamId); validateDeveloperId(options.serviceId);
    identifierValue(options.identifier, options.teamId);
    exact(options, ["teamId", "sessionFile", "serviceId", "identifier", "fetch"]);
    return (await read(transport(options), options)).summary;
  });
}
export function planDeveloperService(options: DeveloperServicePlanOptions): Promise<DeveloperServicePlanSummary> {
  return safeBoundary(async () => {
    scope(options); exact(options, [...scopeFields, ...configFields]);
    const config = configuration(options, options.teamId);
    return withLock(options, async (dir, verify) => {
      checkPending(operations(dir, options.teamId), config.serviceId);
      const t = transport(options);
      const current = await read(t, options);
      await primaryRead(t, options.teamId, config.primaryAppId, config.primaryAppIdentifier);
      const before = fingerprint(current.snapshot);
      const after = fingerprint(target(current.snapshot, config));
      const contents = { version: 1 as const, action: "configure-service" as const, operationId: randomUUID(),
        teamId: options.teamId, environment: options.environment, ...config,
        fingerprint: before, postcondition: after, noOp: before === after };
      const plan = { ...contents, hash: digest(contents) };
      verify();
      writeDeveloperPrivateStore(resolve(options.planFile), canonical(plan), false);
      return summary(plan);
    });
  });
}
async function execute(options: DeveloperServiceScope, reconcile: boolean): Promise<DeveloperServiceReceipt> {
  scope(options); exact(options, scopeFields);
  const plan = readPlan(options);
  return withLock(options, async (dir, verify) => {
    const ops = operations(dir, options.teamId);
    const prior = ops.find(op => op.operationId === plan.operationId);
    if (prior && prior.planHash !== plan.hash) throw new DeveloperError("invalid_operation");
    if (prior?.state === "completed" || (prior && !reconcile)) return prior.receipt ?? uncertain(plan);
    if (reconcile && !prior) throw new DeveloperError("invalid_operation");
    if (!prior) checkPending(ops, plan.serviceId);
    const t = transport(options);
    let op = prior;
    try {
      const current = await read(t, plan);
      await primaryRead(t, plan.teamId, plan.primaryAppId, plan.primaryAppIdentifier);
      if (reconcile) {
        if (fingerprint(current.snapshot) !== plan.postcondition) throw new DeveloperError("resource_mismatch");
      } else {
        if (fingerprint(current.snapshot) !== plan.fingerprint) throw new DeveloperError("stale_plan");
        const intended = target(current.snapshot, plan);
        if (fingerprint(intended) !== plan.postcondition) throw new DeveloperError("invalid_plan");
        if (!plan.noOp && (!current.csrf.csrf || !current.csrf.csrf_ts)) throw new DeveloperError("invalid_response");
        verify();
        op = saveOperation(dir, { version: 1 as const, operationId: plan.operationId, resource: `service:${plan.serviceId}`,
          planHash: plan.hash, plan, state: "pending" as const }, false);
        const indexFile = join(dir, `${digest(op.resource)}.index.json`);
        writeDeveloperPrivateStore(indexFile, canonical({ version: 1, resource: op.resource, operationId: op.operationId,
          planHash: op.planHash }), existsSync(indexFile));
        verify();
        if (!plan.noOp) {
          const response = await t.request(`service-update:${plan.serviceId}`, { method: "PATCH", csrf: current.csrf,
            json: { data: { ...intended, attributes: { ...intended.attributes, teamId: plan.teamId } } } });
          const b = record(response.data) && response.data.data;
          if (!record(b) || b.type !== "bundleIds" || b.id !== plan.serviceId) throw new DeveloperError("resource_mismatch");
          response.accept();
          const actual = await read(t, plan);
          await primaryRead(t, plan.teamId, plan.primaryAppId, plan.primaryAppIdentifier);
          if (fingerprint(actual.snapshot) !== plan.postcondition) throw new DeveloperError("resource_mismatch");
        }
      }
      const completed: DeveloperServiceReceipt = { ...summary(plan), state: "completed" };
      verify();
      const { integrity: _integrity, ...contents } = op!;
      saveOperation(dir, { ...contents, state: "completed", receipt: completed }, true);
      return completed;
    } catch (error) {
      if (!op) throw error;
      const receipt = uncertain(plan, error);
      try {
        verify();
        const { integrity: _integrity, ...contents } = op;
        saveOperation(dir, { ...contents, state: "uncertain", receipt }, true);
      } catch { /* Durable intent remains authoritative even if receipt publication fails. */ }
      return receipt;
    }
  });
}
export function applyDeveloperService(options: DeveloperServiceScope): Promise<DeveloperServiceReceipt> {
  return safeBoundary(() => execute(options, false));
}
export function reconcileDeveloperService(options: DeveloperServiceScope): Promise<DeveloperServiceReceipt> {
  return safeBoundary(() => execute(options, true));
}

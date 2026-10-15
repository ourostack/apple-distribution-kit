import {
  constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync,
  readSync, readdirSync, writeFileSync
} from "node:fs";
import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  acquireDeveloperPrivateLock, assertDeveloperPlatform, checkDeveloperPrivateFile, checkDeveloperPrivateParents,
  DeveloperError, loadDeveloperSession, readDeveloperPrivateInput, releaseDeveloperPrivateLock,
  removeDeveloperOwnedFile, syncDeveloperPrivateDirectory, validateDeveloperId, verifyDeveloperPrivateLock,
  writeDeveloperPrivateStore, type DeveloperPrivateLock
} from "./developer-session.js";
import { createDeveloperTransport, developerRecord as record, type DeveloperTransport } from "./developer-transport.js";
import type { RequiresHuman } from "./plan.js";

const SIWA = "APPLE_ID_AUTH_KEY_CONFIGURATION";
type Action = "create" | "revoke" | "download";
type ApiVersion = "legacy" | "v2";
export interface DeveloperKeyScope {
  teamId: string;
  environment: string;
  sessionFile: string;
  planFile: string;
  fetch?: typeof globalThis.fetch;
}
export type DeveloperKeyPlanOptions = DeveloperKeyScope & {
  primaryAppId: string;
  primaryAppIdentifier: string;
} & (
  { action: "create"; keyName: string } |
  { action: "revoke"; keyId: string } |
  { action: "download"; keyId: string; output: string }
);
interface Primary {
  primaryAppId: string;
  primaryAppIdentifier: string;
}
interface Binding {
  keyId: string;
  keyName: string;
  canDownload: boolean;
  canRevoke: boolean;
  serviceId: typeof SIWA;
  primaryAppId: string;
  primaryIdentifier: string;
  primaryType: "bundle";
  musicKitEnabled: boolean;
  shazamKitEnabled: boolean;
  musicFeedEnabled: boolean;
}
type CreationPayload =
  { teamId: string; name: string; serviceConfigurations: { APPLE_ID_AUTH_KEY_CONFIGURATION: string[] } } |
  { teamId: string; name: string; serviceConfigurationsRequests: { serviceId: typeof SIWA; isNew: true; identifiers: { bundle: string[] } }[] };
interface Plan extends Primary {
  version: 1;
  operationId: string;
  action: Action;
  teamId: string;
  environment: string;
  keyName: string;
  keyId?: string;
  output?: string;
  fingerprint: string;
  apiVersion?: ApiVersion;
  creationPayload?: CreationPayload;
  hash: string;
}
export interface DeveloperKeyPlanSummary {
  version: 1;
  operationId: string;
  action: Action;
  teamId: string;
  environment: string;
  primaryAppId: string;
  primaryAppIdentifier: string;
  keyName: string;
  keyId?: string;
  planHash: string;
}
export interface DeveloperKeyReceipt extends DeveloperKeyPlanSummary {
  state: "completed" | "uncertain";
  sha256?: string;
  errorCode?: DeveloperError["code"];
  requiresHuman?: RequiresHuman;
}
interface Operation {
  version: 1;
  operationId: string;
  planHash: string;
  planFile: string;
  teamId: string;
  environment: string;
  action: Action;
  keyName: string;
  keyId?: string;
  primaryAppId: string;
  primaryAppIdentifier: string;
  resource: string;
  state: "pending" | "uncertain" | "completed";
  recoveryFile?: string;
  receipt?: DeveloperKeyReceipt;
  integrity: string;
}

function text(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}
function validatePrimary(value: Primary, teamId: string): void {
  validateDeveloperId(value.primaryAppId);
  if (!text(value.primaryAppIdentifier, 255) || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value.primaryAppIdentifier) ||
    value.primaryAppIdentifier.startsWith(`${teamId}.`)) throw new DeveloperError("invalid_arguments");
}
function validateScope(options: DeveloperKeyScope): void {
  assertDeveloperPlatform();
  validateDeveloperId(options.teamId);
  if (!text(options.environment, 64) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.environment) ||
    !text(options.sessionFile, 4096) || !text(options.planFile, 4096)) throw new DeveloperError("invalid_arguments");
}
function exactOptions(options: object, allowed: string[]): void {
  if (Object.keys(options).some(k => !allowed.includes(k))) throw new DeveloperError("invalid_arguments");
}
const scopeFields = ["teamId", "environment", "sessionFile", "planFile", "fetch"];
function validatePlanOptions(options: DeveloperKeyPlanOptions): void {
  validateScope(options);
  validatePrimary(options, options.teamId);
  if (!["create", "revoke", "download"].includes(options.action)) throw new DeveloperError("invalid_arguments");
  exactOptions(options, [...scopeFields, "primaryAppId", "primaryAppIdentifier", "action",
    ...(options.action === "create" ? ["keyName"] : options.action === "revoke" ? ["keyId"] : ["keyId", "output"])]);
  if (options.action === "create") {
    if (!text(options.keyName) || options.keyName.trim() !== options.keyName) throw new DeveloperError("invalid_arguments");
  } else {
    validateDeveloperId(options.keyId);
    if (options.action === "download" && !text(options.output, 4096)) throw new DeveloperError("invalid_arguments");
  }
}
function payload(teamId: string, name: string, primaryAppId: string, version: ApiVersion): CreationPayload {
  return version === "v2" ?
    { teamId, name, serviceConfigurationsRequests: [{ serviceId: SIWA, isNew: true, identifiers: { bundle: [primaryAppId] } }] } :
    { teamId, name, serviceConfigurations: { APPLE_ID_AUTH_KEY_CONFIGURATION: [primaryAppId] } };
}
function summary(plan: Plan): DeveloperKeyPlanSummary {
  return {
    version: 1, operationId: plan.operationId, action: plan.action, teamId: plan.teamId, environment: plan.environment,
    primaryAppId: plan.primaryAppId, primaryAppIdentifier: plan.primaryAppIdentifier,
    keyName: plan.keyName, ...(plan.keyId ? { keyId: plan.keyId } : {}), planHash: plan.hash
  };
}
function receipt(plan: Plan, state: "completed" | "uncertain", fields: { keyId?: string; sha256?: string } = {}): DeveloperKeyReceipt {
  return { ...summary(plan), state, ...fields };
}
function uncertainReceipt(plan: Plan, error: unknown): DeveloperKeyReceipt {
  const safe = error instanceof DeveloperError ? error : new DeveloperError(plan.action === "download" ? "unsafe_output" : "unsafe_session_store");
  return { ...receipt(plan, "uncertain"), errorCode: safe.code, ...(safe.requiresHuman ? { requiresHuman: safe.requiresHuman } : {}) };
}
function readPlan(options: DeveloperKeyScope): Plan {
  const raw = readDeveloperPrivateInput(options.planFile);
  try {
    if (!record(raw) || raw.version !== 1 || !uuid(raw.operationId) ||
      !validHash(raw.hash) || !validHash(raw.fingerprint) || !text(raw.keyName) ||
      !["create", "revoke", "download"].includes(String(raw.action))) throw new DeveloperError("invalid_plan");
    const action = raw.action as Action;
    const primary = { primaryAppId: String(raw.primaryAppId), primaryAppIdentifier: String(raw.primaryAppIdentifier) };
    const base = { teamId: String(raw.teamId), environment: String(raw.environment), sessionFile: options.sessionFile, planFile: options.planFile };
    const input: DeveloperKeyPlanOptions = { ...base, ...primary,
      ...(action === "create" ? { action, keyName: raw.keyName } :
        action === "revoke" ? { action, keyId: String(raw.keyId) } : { action, keyId: String(raw.keyId), output: String(raw.output) })
    };
    validatePlanOptions(input);
    const normalized: Omit<Plan, "hash"> = {
      version: 1, operationId: raw.operationId, action, teamId: base.teamId, environment: base.environment,
      ...primary, keyName: raw.keyName, fingerprint: raw.fingerprint,
      ...(action === "create" ? {
        apiVersion: raw.apiVersion === "v2" ? "v2" : "legacy",
        creationPayload: payload(base.teamId, raw.keyName, primary.primaryAppId, raw.apiVersion === "v2" ? "v2" : "legacy")
      } : { keyId: String(raw.keyId), ...(action === "download" ? { output: resolve(String(raw.output)) } : {}) })
    };
    if (action === "create" && raw.apiVersion !== "legacy" && raw.apiVersion !== "v2") throw new DeveloperError("invalid_plan");
    const plan: Plan = { ...normalized, hash: digest(normalized) };
    if (canonical(raw) !== canonical(plan)) throw new DeveloperError("invalid_plan");
    if (plan.teamId !== options.teamId) throw new DeveloperError("team_mismatch");
    if (plan.environment !== options.environment) throw new DeveloperError("scope_mismatch");
    return plan;
  } catch (error) {
    if (error instanceof DeveloperError && ["team_mismatch", "scope_mismatch"].includes(error.code)) throw error;
    throw new DeveloperError("invalid_plan");
  }
}
function transport(options: DeveloperKeyScope): DeveloperTransport {
  const session = loadDeveloperSession(options);
  return createDeveloperTransport({ teamId: options.teamId, session, ...(options.fetch ? { fetch: options.fetch } : {}) });
}
async function primaryRead(t: DeveloperTransport, scope: Primary & { teamId: string }): Promise<void> {
  const response = await t.request(`bundle:${scope.primaryAppId}`, { json: { teamId: scope.teamId } });
  const { data } = response;
  if (!record(data) || !record(data.data) || data.data.type !== "bundleIds" || data.data.id !== scope.primaryAppId ||
    !record(data.data.attributes) || data.data.attributes.identifier !== scope.primaryAppIdentifier ||
    data.data.attributes.seedId !== scope.teamId) throw new DeveloperError("resource_mismatch");
  response.accept();
}
interface InventoryKey { keyId: string; keyName: string }
async function inventoryRead(t: DeveloperTransport): Promise<{
  keys: InventoryKey[]; csrf: { csrf: string; csrf_ts: string };
}> {
  const result: InventoryKey[] = [];
  const seen = new Set<string>();
  let csrf: { csrf: string; csrf_ts: string } | undefined;
  for (let page = 1; page <= 100; page++) {
    const response = await t.request("account/auth/key/list", { fields: { pageNumber: String(page), pageSize: "50", sort: "name=asc" } });
    const token = response.headers.get("csrf");
    const timestamp = response.headers.get("csrf_ts");
    if (token && timestamp && /^[\x21-\x7e]{1,1024}$/.test(token) && /^[0-9]{1,32}$/.test(timestamp)) {
      csrf = { csrf: token, csrf_ts: timestamp };
    }
    const data = response.data;
    if (!record(data) || !Array.isArray(data.keys) || data.keys.length > 50) throw new DeveloperError("invalid_response");
    for (const key of data.keys) {
      if (!record(key) || !text(key.keyName) || typeof key.keyId !== "string" ||
        !/^[A-Z0-9]{10}$/.test(key.keyId) || !Array.isArray(key.services) ||
        key.services.some(s => !record(s) || !text(s.id, 128))) throw new DeveloperError("invalid_response");
      if (seen.has(key.keyId)) throw new DeveloperError("pagination_non_progress");
      seen.add(key.keyId);
      result.push({ keyId: key.keyId, keyName: key.keyName });
    }
    response.accept();
    if (data.keys.length < 50) {
      // Reads need not return CSRF; only an apply fresh-list requires it.
      return { keys: result, csrf: csrf ?? { csrf: "", csrf_ts: "" } };
    }
  }
  throw new DeveloperError("pagination_limit");
}
async function versionRead(t: DeveloperTransport): Promise<ApiVersion> {
  const response = await t.request("permissions", { fields: { permissions: "team.authkey.create,team.authkey.apns.enhanced.access" } });
  const { data } = response;
  if (!record(data) || !Array.isArray(data.permissions)) throw new DeveloperError("invalid_response");
  const flags = new Map<string, boolean>();
  for (const item of data.permissions) {
    if (!record(item) || typeof item.permission !== "string" || typeof item.accessAllowed !== "boolean" || flags.has(item.permission)) {
      throw new DeveloperError("invalid_response");
    }
    flags.set(item.permission, item.accessAllowed);
  }
  if (flags.get("team.authkey.create") !== true) throw new DeveloperError("permission_denied");
  const enhanced = flags.get("team.authkey.apns.enhanced.access");
  if (enhanced === undefined) throw new DeveloperError("invalid_response");
  response.accept();
  return enhanced ? "v2" : "legacy";
}
async function bindingRead(t: DeveloperTransport, scope: Primary & { teamId: string }, keyId: string): Promise<Binding> {
  const response = await t.request("account/auth/key/get", { fields: { keyId } });
  const { data } = response;
  if (!record(data) || !Array.isArray(data.keys) || data.keys.length !== 1) throw new DeveloperError("resource_mismatch");
  const key: unknown = data.keys[0];
  if (!record(key) || key.keyId !== keyId || !text(key.keyName) ||
    typeof key.canDownload !== "boolean" || typeof key.canRevoke !== "boolean" ||
    !Array.isArray(key.services) || key.services.length !== 1) throw new DeveloperError("resource_mismatch");
  const service: unknown = key.services[0];
  if (!record(service) || service.id !== SIWA || !text(service.name) || !Array.isArray(service.relatedKeys) ||
    !Array.isArray(service.configurations) || service.configurations.length !== 1) throw new DeveloperError("resource_mismatch");
  const config: unknown = service.configurations[0];
  if (!record(config) || config.id !== scope.primaryAppId ||
    config.identifier !== `${scope.teamId}.${scope.primaryAppIdentifier}` || config.type !== "bundle" ||
    !text(config.name) || typeof config.musicKitEnabled !== "boolean" ||
    typeof config.shazamKitEnabled !== "boolean" || typeof config.musicFeedEnabled !== "boolean") throw new DeveloperError("resource_mismatch");
  // Extra capability flags are an unexpected multi-purpose configuration, even within the SIWA service.
  if (config.musicKitEnabled || config.shazamKitEnabled || config.musicFeedEnabled || service.relatedKeys.length !== 0) {
    throw new DeveloperError("resource_mismatch");
  }
  response.accept();
  return {
    keyId, keyName: key.keyName, canDownload: key.canDownload, canRevoke: key.canRevoke,
    serviceId: SIWA, primaryAppId: scope.primaryAppId, primaryIdentifier: `${scope.teamId}.${scope.primaryAppIdentifier}`,
    primaryType: "bundle", musicKitEnabled: false, shazamKitEnabled: false, musicFeedEnabled: false
  };
}
function fingerprint(scope: Primary & { teamId: string }, binding?: Binding, version?: ApiVersion): string {
  return digest({ teamId: scope.teamId, primaryAppId: scope.primaryAppId, primaryAppIdentifier: scope.primaryAppIdentifier,
    ...(binding ? { binding } : {}), ...(version ? { apiVersion: version } : {}) });
}
function directory(teamId: string): string {
  assertDeveloperPlatform();
  const base = join(homedir(), ".apple-distribution-kit");
  for (const dir of [base, join(base, "developer-operations"), join(base, "developer-operations", teamId)]) {
    checkDeveloperPrivateParents(join(dir, "placeholder"), true);
  }
  return join(base, "developer-operations", teamId);
}
function resource(action: Action, keyName: string, keyId?: string): string {
  return action === "create" ? `name:${keyName}` : `key:${keyId}`;
}
function operationFile(dir: string, id: string): string { return join(dir, `${id}.json`); }
const safeErrorCodes = new Set<DeveloperError["code"]>([
  "invalid_arguments", "invalid_session", "unsafe_session_store", "session_exists", "session_store_busy",
  "unsupported_platform", "agreement_required", "team_mismatch", "session_expired", "sign_in_required",
  "permission_denied", "redirect_rejected", "network_error", "http_error", "apple_error", "invalid_response",
  "pagination_non_progress", "pagination_limit", "invalid_plan", "stale_plan", "resource_mismatch",
  "resource_exists", "scope_mismatch", "operation_pending", "invalid_operation", "unsafe_output"
]);
function operationReceipt(raw: unknown, op: Omit<Operation, "receipt" | "integrity">): DeveloperKeyReceipt {
  if (!record(raw) || raw.state !== op.state || (op.state !== "completed" && op.state !== "uncertain")) {
    throw new DeveloperError("invalid_operation");
  }
  const value: DeveloperKeyReceipt = {
    version: 1, operationId: op.operationId, action: op.action, teamId: op.teamId, environment: op.environment,
    primaryAppId: op.primaryAppId, primaryAppIdentifier: op.primaryAppIdentifier, keyName: op.keyName,
    planHash: op.planHash, state: op.state
  };
  if (op.action === "create" && op.state === "completed") {
    validateDeveloperId(raw.keyId);
    value.keyId = raw.keyId;
  } else if (op.keyId) value.keyId = op.keyId;
  if (op.action === "download" && op.state === "completed") {
    if (!validHash(raw.sha256)) throw new DeveloperError("invalid_operation");
    value.sha256 = raw.sha256;
  }
  if (op.state === "uncertain" && raw.errorCode !== undefined) {
    if (!safeErrorCodes.has(raw.errorCode as DeveloperError["code"])) throw new DeveloperError("invalid_operation");
    value.errorCode = raw.errorCode as DeveloperError["code"];
    const human = new DeveloperError(value.errorCode).requiresHuman;
    if (human) value.requiresHuman = human;
  }
  if (canonical(raw) !== canonical(value)) throw new DeveloperError("invalid_operation");
  return value;
}
function readOperation(file: string, teamId: string): Operation {
  const raw = readDeveloperPrivateInput(file);
  if (!record(raw) || raw.version !== 1 || !uuid(raw.operationId) || !validHash(raw.planHash) ||
    !validHash(raw.integrity) || raw.teamId !== teamId || !text(raw.environment, 64) ||
    !text(raw.keyName) || !text(raw.planFile, 4096) || !text(raw.resource, 300) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(raw.environment) ||
    !["pending", "uncertain", "completed"].includes(String(raw.state)) ||
    !["create", "revoke", "download"].includes(String(raw.action)) ||
    typeof raw.primaryAppId !== "string" || typeof raw.primaryAppIdentifier !== "string") throw new DeveloperError("invalid_operation");
  const { integrity, ...contents } = raw;
  if (digest(contents) !== integrity || raw.resource !== resource(raw.action as Action, raw.keyName, typeof raw.keyId === "string" ? raw.keyId : undefined)) {
    throw new DeveloperError("invalid_operation");
  }
  validatePrimary({ primaryAppId: raw.primaryAppId, primaryAppIdentifier: raw.primaryAppIdentifier }, teamId);
  if (raw.keyId !== undefined) validateDeveloperId(raw.keyId);
  if (raw.action !== "create" && raw.keyId === undefined) throw new DeveloperError("invalid_operation");
  if (raw.action === "create" && raw.keyId !== undefined) throw new DeveloperError("invalid_operation");
  if (resolve(file) !== operationFile(dirname(resolve(file)), raw.operationId)) throw new DeveloperError("invalid_operation");
  if (Object.keys(raw).some(k => !["version", "operationId", "planHash", "planFile", "teamId", "environment", "action",
    "keyName", "keyId", "primaryAppId", "primaryAppIdentifier", "resource", "state", "recoveryFile", "receipt", "integrity"].includes(k))) {
    throw new DeveloperError("invalid_operation");
  }
  if (raw.recoveryFile !== undefined &&
    (raw.action !== "download" || raw.recoveryFile !== join(dirname(resolve(file)), `${raw.operationId}.recovery.p8`))) throw new DeveloperError("invalid_operation");
  const op = raw as unknown as Operation;
  if (raw.receipt !== undefined) op.receipt = operationReceipt(raw.receipt, op);
  else if (raw.state === "completed") throw new DeveloperError("invalid_operation");
  return op;
}
function allOperations(dir: string, teamId: string): Operation[] {
  const entries = readdirSync(dir);
  const files = entries.filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
  if (files.length > 10_000) throw new DeveloperError("invalid_operation");
  const ops = files.map(file => readOperation(join(dir, file), teamId));
  const indexes = entries.filter(name => /^[a-f0-9]{64}\.index\.json$/.test(name));
  if (indexes.length > 10_000) throw new DeveloperError("invalid_operation");
  for (const name of indexes) {
    const index = readDeveloperPrivateInput(join(dir, name));
    if (!record(index) || index.version !== 1 || !uuid(index.operationId) || !validHash(index.planHash) || !text(index.resource, 300)) {
      throw new DeveloperError("invalid_operation");
    }
    const op = ops.find(o => o.operationId === index.operationId);
    if (!op || op.resource !== index.resource || op.planHash !== index.planHash ||
      name !== `${digest(index.resource)}.index.json` ||
      canonical(index) !== canonical({ version: 1, resource: op.resource, operationId: op.operationId, planHash: op.planHash })) {
      throw new DeveloperError("invalid_operation");
    }
  }
  return ops;
}
function checkPending(dir: string, plan: { action: Action; keyName: string; keyId?: string; teamId: string }, except?: string): void {
  for (const op of allOperations(dir, plan.teamId)) {
    if (op.operationId === except || op.state === "completed") continue;
    if (op.resource === resource(plan.action, plan.keyName, plan.keyId) ||
      (op.action === "create" && op.keyName === plan.keyName) ||
      (plan.action === "create" && op.keyName === plan.keyName)) throw new DeveloperError("operation_pending");
  }
}
function saveOperation(dir: string, operation: Omit<Operation, "integrity">, replace: boolean): Operation {
  const value: Operation = { ...operation, integrity: digest(operation) };
  try { writeDeveloperPrivateStore(operationFile(dir, operation.operationId), canonical(value), replace); }
  catch (error) {
    if (error instanceof DeveloperError) throw error;
    throw new DeveloperError("unsafe_session_store");
  }
  return value;
}
function updateOperation(dir: string, op: Operation, fields: Partial<Pick<Operation, "state" | "receipt" | "recoveryFile">>): Operation {
  const { integrity: _integrity, ...contents } = op;
  return saveOperation(dir, { ...contents, ...fields }, true);
}
async function checkPriorCreation(dir: string, plan: { teamId: string; keyName: string }, keys: InventoryKey[]): Promise<void> {
  for (const op of allOperations(dir, plan.teamId)) {
    if (op.action === "create" && op.keyName === plan.keyName && op.state === "completed") {
      if (keys.some(k => k.keyId === op.receipt!.keyId)) throw new DeveloperError("resource_exists");
    }
  }
}

async function planKey(options: DeveloperKeyPlanOptions): Promise<DeveloperKeyPlanSummary> {
  validatePlanOptions(options);
  const t = transport(options);
  const dir = directory(options.teamId);
  const lock = acquireDeveloperPrivateLock(join(dir, "operations"));
  try {
    await primaryRead(t, options);
    const inventory = await inventoryRead(t);
    let name: string;
    let binding: Binding | undefined;
    let version: ApiVersion | undefined;
    if (options.action === "create") {
      name = options.keyName;
      checkPending(dir, { ...options, keyName: name });
      if (inventory.keys.some(k => k.keyName === name)) throw new DeveloperError("resource_exists");
      await checkPriorCreation(dir, { teamId: options.teamId, keyName: name }, inventory.keys);
      version = await versionRead(t);
    } else {
      binding = await bindingRead(t, options, options.keyId);
      name = binding.keyName;
      checkPending(dir, { ...options, keyName: name });
      if (!(options.action === "revoke" ? binding.canRevoke : binding.canDownload)) throw new DeveloperError("permission_denied");
    }
    const contents: Omit<Plan, "hash"> = {
      version: 1, operationId: randomUUID(), action: options.action, teamId: options.teamId,
      environment: options.environment, primaryAppId: options.primaryAppId, primaryAppIdentifier: options.primaryAppIdentifier,
      keyName: name, fingerprint: fingerprint(options, binding, version),
      ...(options.action === "create" ? { apiVersion: version!, creationPayload: payload(options.teamId, name, options.primaryAppId, version!) } :
        { keyId: options.keyId, ...(options.action === "download" ? { output: resolve(options.output) } : {}) })
    };
    const plan: Plan = { ...contents, hash: digest(contents) };
    verifyDeveloperPrivateLock(lock);
    try { writeDeveloperPrivateStore(resolve(options.planFile), canonical(plan), false); }
    catch (error) {
      if (error instanceof DeveloperError) throw error;
      throw new DeveloperError("unsafe_session_store");
    }
    return summary(plan);
  } finally { releaseDeveloperPrivateLock(lock); }
}
function reserve(file: string): DeveloperPrivateLock {
  try {
    checkDeveloperPrivateParents(file, false);
    const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { checkDeveloperPrivateFile(fstatSync(fd)); fsyncSync(fd); syncDeveloperPrivateDirectory(file); }
    catch (error) { closeSync(fd); throw error; }
    return { path: file, fd };
  } catch { throw new DeveloperError("unsafe_output"); }
}
function verifyOwned(file: DeveloperPrivateLock): void {
  checkDeveloperPrivateParents(file.path, false);
  const actual = lstatSync(file.path);
  const acquired = fstatSync(file.fd);
  checkDeveloperPrivateFile(actual);
  checkDeveloperPrivateFile(acquired);
  if (actual.dev !== acquired.dev || actual.ino !== acquired.ino) throw new DeveloperError("unsafe_output");
}
function keyHash(buffer: Buffer): string {
  const source = buffer.toString("utf8");
  if (buffer.length > 16_384 || !/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PRIVATE KEY-----\r?\n?$/.test(source)) {
    throw new DeveloperError("invalid_response");
  }
  try {
    const key = createPrivateKey({ key: source, format: "pem", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
  } catch { throw new DeveloperError("invalid_response"); }
  return createHash("sha256").update(buffer).digest("hex");
}
function persistedKeyHash(file: DeveloperPrivateLock): string {
  verifyOwned(file);
  const size = fstatSync(file.fd).size;
  if (size > 16_384) throw new DeveloperError("unsafe_output");
  const buffer = Buffer.alloc(size);
  if (readSync(file.fd, buffer, 0, size, 0) !== size) throw new DeveloperError("unsafe_output");
  return keyHash(buffer);
}
async function createdKey(t: DeveloperTransport, plan: Plan): Promise<Binding> {
  const inventory = await inventoryRead(t);
  const matches = inventory.keys.filter(k => k.keyName === plan.keyName);
  if (matches.length !== 1) throw new DeveloperError("resource_mismatch");
  const binding = await bindingRead(t, plan, matches[0]!.keyId);
  if (binding.keyName !== plan.keyName) throw new DeveloperError("resource_mismatch");
  return binding;
}
function existingOperation(dir: string, plan: Plan): Operation | undefined {
  const file = operationFile(dir, plan.operationId);
  if (!existsSync(file)) return undefined;
  const op = readOperation(file, plan.teamId);
  if (op.planHash !== plan.hash || op.action !== plan.action || op.environment !== plan.environment ||
    op.keyName !== plan.keyName || op.keyId !== plan.keyId ||
    op.primaryAppId !== plan.primaryAppId || op.primaryAppIdentifier !== plan.primaryAppIdentifier) {
    throw new DeveloperError("invalid_operation");
  }
  return op;
}
function replay(plan: Plan, op: Operation): DeveloperKeyReceipt {
  return op.receipt ?? receipt(plan, "uncertain");
}

async function applyKey(options: DeveloperKeyScope): Promise<DeveloperKeyReceipt> {
  validateScope(options);
  exactOptions(options, scopeFields);
  const plan = readPlan(options);
  const dir = directory(options.teamId);
  const lock = acquireDeveloperPrivateLock(join(dir, "operations"));
  let output: DeveloperPrivateLock | undefined;
  let recovery: DeveloperPrivateLock | undefined;
  let requested = false;
  try {
    const existing = existingOperation(dir, plan);
    if (existing) return replay(plan, existing);
    checkPending(dir, plan);
    const t = transport(options);
    await primaryRead(t, plan);
    if (plan.action === "create") {
      if (await versionRead(t) !== plan.apiVersion) throw new DeveloperError("stale_plan");
      if (fingerprint(plan, undefined, plan.apiVersion) !== plan.fingerprint) throw new DeveloperError("stale_plan");
    } else {
      const binding = await bindingRead(t, plan, plan.keyId!);
      if (fingerprint(plan, binding) !== plan.fingerprint ||
        !(plan.action === "revoke" ? binding.canRevoke : binding.canDownload)) throw new DeveloperError("stale_plan");
    }
    // This fresh list is also the final scoped CSRF source immediately before the effect.
    const inventory = await inventoryRead(t);
    if (!inventory.csrf.csrf || !inventory.csrf.csrf_ts) throw new DeveloperError("invalid_response");
    if (plan.action === "create") {
      if (inventory.keys.some(k => k.keyName === plan.keyName)) throw new DeveloperError("resource_exists");
      await checkPriorCreation(dir, plan, inventory.keys);
    } else if (!inventory.keys.some(k => k.keyId === plan.keyId && k.keyName === plan.keyName)) throw new DeveloperError("stale_plan");
    verifyDeveloperPrivateLock(lock);
    if (plan.action === "download") {
      output = reserve(plan.output!);
      recovery = reserve(join(dir, `${plan.operationId}.recovery.p8`));
    }
    const contents: Omit<Operation, "integrity"> = {
      version: 1, operationId: plan.operationId, planHash: plan.hash, planFile: resolve(options.planFile),
      teamId: plan.teamId, environment: plan.environment, action: plan.action,
      keyName: plan.keyName, ...(plan.keyId ? { keyId: plan.keyId } : {}),
      primaryAppId: plan.primaryAppId, primaryAppIdentifier: plan.primaryAppIdentifier,
      resource: resource(plan.action, plan.keyName, plan.keyId), state: "pending",
      ...(recovery ? { recoveryFile: recovery.path } : {})
    };
    let op = saveOperation(dir, contents, false);
    // Stable resource index, independent of session pathname, nonce and declared environment.
    writeDeveloperPrivateStore(join(dir, `${digest(op.resource)}.index.json`),
      canonical({ version: 1, resource: op.resource, operationId: op.operationId, planHash: op.planHash }),
      existsSync(join(dir, `${digest(op.resource)}.index.json`)));
    verifyDeveloperPrivateLock(lock);
    try {
      requested = true;
      let completed: DeveloperKeyReceipt;
      if (plan.action === "create") {
        const response = await t.request(plan.apiVersion === "v2" ? "account/auth/key/v2/create" : "account/auth/key/create",
          { json: plan.creationPayload, csrf: inventory.csrf });
        response.accept();
        const key = await createdKey(t, plan);
        completed = receipt(plan, "completed", { keyId: key.keyId });
      } else if (plan.action === "revoke") {
        const response = await t.request("account/auth/key/revoke", { fields: { keyId: plan.keyId! }, csrf: inventory.csrf });
        response.accept();
        if ((await inventoryRead(t)).keys.some(k => k.keyId === plan.keyId)) throw new DeveloperError("resource_mismatch");
        completed = receipt(plan, "completed");
      } else {
        const response = await t.request(`account/auth/key/download?teamId=${plan.teamId}&keyId=${plan.keyId!}`,
          { method: "GET", binary: true, csrf: inventory.csrf });
        const data = response.data as Buffer;
        const hash = keyHash(data);
        verifyOwned(recovery!);
        writeFileSync(recovery!.fd, data); fsyncSync(recovery!.fd);
        if (persistedKeyHash(recovery!) !== hash) throw new DeveloperError("unsafe_output");
        response.accept();
        verifyOwned(output!);
        writeFileSync(output!.fd, data); fsyncSync(output!.fd);
        if (persistedKeyHash(output!) !== hash) throw new DeveloperError("unsafe_output");
        verifyOwned(output!);
        syncDeveloperPrivateDirectory(output!.path);
        completed = receipt(plan, "completed", { sha256: hash });
      }
      op = updateOperation(dir, op, { state: "completed", receipt: completed });
      if (recovery) {
        const owned = recovery;
        recovery = undefined;
        removeDeveloperOwnedFile(owned);
      }
      return completed;
    } catch (error) {
      // Never convert unknown vendor/persistence outcomes into a new attempt.
      const uncertain = uncertainReceipt(plan, error);
      try { updateOperation(dir, op, { state: "uncertain", receipt: uncertain }); } catch { /* The fsynced pending intent still blocks replay. */ }
      return uncertain;
    }
  } finally {
    let cleanupError: unknown;
    for (const owned of [output, recovery]) {
      if (!owned) continue;
      try {
        if (requested) closeSync(owned.fd);
        else removeDeveloperOwnedFile(owned);
      } catch (error) { cleanupError ??= error; }
    }
    try { releaseDeveloperPrivateLock(lock); }
    catch (error) { cleanupError ??= error; }
    if (cleanupError) throw cleanupError;
  }
}

async function reconcileKey(options: DeveloperKeyScope): Promise<DeveloperKeyReceipt> {
  validateScope(options);
  exactOptions(options, scopeFields);
  const plan = readPlan(options);
  const dir = directory(options.teamId);
  const lock = acquireDeveloperPrivateLock(join(dir, "operations"));
  try {
    const op = existingOperation(dir, plan);
    if (!op) throw new DeveloperError("invalid_operation");
    if (op.state === "completed" || plan.action === "download") return replay(plan, op);
    const t = transport(options);
    let completed: DeveloperKeyReceipt;
    try {
      await primaryRead(t, plan);
      if (plan.action === "create") {
        const key = await createdKey(t, plan);
        completed = receipt(plan, "completed", { keyId: key.keyId });
      } else {
        if ((await inventoryRead(t)).keys.some(k => k.keyId === plan.keyId)) return receipt(plan, "uncertain");
        completed = receipt(plan, "completed");
      }

    } catch (error) { return uncertainReceipt(plan, error); }
    try { updateOperation(dir, op, { state: "completed", receipt: completed }); }
    catch (error) { return uncertainReceipt(plan, error); }
    return completed;
  } finally { releaseDeveloperPrivateLock(lock); }
}

async function safeBoundary<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof DeveloperError) throw error;
    throw new DeveloperError("unsafe_session_store");
  }
}

/** Read-only vendor planning plus exclusive private plan publication. */
export function planDeveloperKey(options: DeveloperKeyPlanOptions): Promise<DeveloperKeyPlanSummary> {
  return safeBoundary(() => planKey(options));
}

/** Applies only the exact immutable private plan; all unknown effects are durable and nonretryable. */
export function applyDeveloperKey(options: DeveloperKeyScope): Promise<DeveloperKeyReceipt> {
  return safeBoundary(() => applyKey(options));
}

/** Read-only postcondition reconciliation; never retries a vendor effect. */
export function reconcileDeveloperKey(options: DeveloperKeyScope): Promise<DeveloperKeyReceipt> {
  return safeBoundary(() => reconcileKey(options));
}

import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Cookie, CookieJar } from "tough-cookie";
import { createRequiresHuman, type RequiresHuman } from "./plan.js";

export const DEVELOPER_BASE_URL = "https://developer.apple.com/services-account/QH65B2/";
export type DeveloperReadPath = "account/auth/key/list" | "account/auth/key/get";
/** Internal capability, not exported by the package entry point. */
export const developerTransportAccess = Symbol("developerTransportAccess");
export type DeveloperTransportPath = DeveloperReadPath | "account/auth/key/create" | "account/auth/key/v2/create" |
  "account/auth/key/revoke" | `account/auth/key/download?teamId=${string}&keyId=${string}` |
  "permissions" | `bundle:${string}` | `service:${string}` | `service-update:${string}`;
export type DeveloperErrorCode =
  | "invalid_arguments" | "invalid_session" | "unsafe_session_store" | "session_exists"
  | "session_store_busy"
  | "unsupported_platform" | "agreement_required"
  | "team_mismatch" | "session_expired" | "sign_in_required" | "permission_denied"
  | "redirect_rejected" | "network_error" | "http_error" | "apple_error"
  | "invalid_response" | "pagination_non_progress" | "pagination_limit"
  | DeveloperLifecycleErrorCode;
export type DeveloperLifecycleErrorCode =
  | "invalid_plan" | "stale_plan" | "resource_mismatch" | "resource_exists"
  | "scope_mismatch" | "operation_pending" | "invalid_operation" | "unsafe_output";

export class DeveloperError extends Error {
  readonly requiresHuman?: RequiresHuman;
  constructor(readonly code: DeveloperErrorCode) {
    super(`Developer operation failed (${code}).`);
    this.name = "DeveloperError";
    if (code === "session_expired" || code === "sign_in_required") {
      this.requiresHuman = createRequiresHuman({
        code: "developer_sign_in_required",
        message: "Sign in to Apple Developer manually, then enroll a refreshed session.",
        url: "https://developer.apple.com/account/"
      });
    } else if (code === "agreement_required") {
      this.requiresHuman = createRequiresHuman({
        code: "developer_agreement_required",
        message: "Review and accept the Apple Developer agreement manually before further Developer requests.",
        url: "https://developer.apple.com/register/agree/"
      });
    }
  }
}

export interface DeveloperEnrollmentCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires: number;
  sameSite?: "Strict" | "Lax" | "None";
}
export interface DeveloperEnrollment {
  teamId: string;
  cookies: DeveloperEnrollmentCookie[];
}

export function assertDeveloperPlatform(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new DeveloperError("unsupported_platform");
}

export function validateDeveloperId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Z0-9]{10}$/.test(value)) throw new DeveloperError("invalid_arguments");
}

export function developerReadUrl(path: DeveloperReadPath): string {
  if (path !== "account/auth/key/list" && path !== "account/auth/key/get") throw new DeveloperError("invalid_arguments");
  return DEVELOPER_BASE_URL + path;
}

export function developerTransportUrl(path: DeveloperTransportPath): string {
  if (path === "permissions") return "https://developer.apple.com/services-account/checkPermissions";
  if (/^service(?:-update)?:[A-Z0-9]{10}$/.test(path)) {
    const id = path.slice(path.indexOf(":") + 1);
    return `https://developer.apple.com/services-account/v1/bundleIds/${id}` +
      (path.startsWith("service:") ? "?include=bundleIdCapabilities,bundleIdCapabilities.capability,bundleIdCapabilities.appConsentBundleId" : "");
  }
  if (/^bundle:[A-Z0-9]{10}$/.test(path)) {
    return `https://developer.apple.com/services-account/v1/bundleIds/${path.slice(7)}?fields[bundleIds]=name,identifier,seedId&include=bundleIdCapabilities.relatedAppConsentBundleIds`;
  }
  if (["account/auth/key/list", "account/auth/key/get", "account/auth/key/create",
    "account/auth/key/v2/create", "account/auth/key/revoke"].includes(path) ||
    /^account\/auth\/key\/download\?teamId=[A-Z0-9]{10}&keyId=[A-Z0-9]{10}$/.test(path)) return DEVELOPER_BASE_URL + path;
  throw new DeveloperError("invalid_arguments");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eligible(cookie: Cookie, ignoreExpiry = false): boolean {
  try {
    if (ignoreExpiry) {
      cookie = cookie.clone()!;
      cookie.expires = "Infinity";
      cookie.maxAge = null;
    }
    if (!cookie.secure || !cookie.validate()) return false;
    const test = new CookieJar();
    test.setCookieSync(cookie, DEVELOPER_BASE_URL);
    return test.getCookiesSync(DEVELOPER_BASE_URL).length === 1;
  } catch { return false; }
}

function enrollmentJar(input: unknown, teamId: string): CookieJar {
  if (!record(input) || input.teamId !== teamId) throw new DeveloperError("team_mismatch");
  if (!Array.isArray(input.cookies) || input.cookies.length === 0 || input.cookies.length > 200) throw new DeveloperError("invalid_session");
  const jar = new CookieJar();
  for (const item of input.cookies) {
    if (!record(item) || typeof item.name !== "string" || typeof item.value !== "string" ||
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(item.name) || /[\x00-\x20\x7f;\\",]/.test(item.value) ||
      typeof item.domain !== "string" || typeof item.path !== "string" || !item.path.startsWith("/") ||
      typeof item.secure !== "boolean" || typeof item.httpOnly !== "boolean" ||
      typeof item.expires !== "number" || !Number.isFinite(item.expires) ||
      (item.expires !== -1 && item.expires <= Date.now() / 1000) ||
      (item.sameSite !== undefined && !["Strict", "Lax", "None"].includes(String(item.sameSite)))) {
      throw new DeveloperError("invalid_session");
    }
    const expires = item.expires === -1 ? "Infinity" : new Date(item.expires * 1000);
    if (expires instanceof Date && !Number.isFinite(expires.getTime())) throw new DeveloperError("invalid_session");
    const cookie = new Cookie({
      key: item.name, value: item.value, domain: item.domain.replace(/^\./, "").toLowerCase(),
      path: item.path, secure: item.secure, httpOnly: item.httpOnly, expires,
      hostOnly: !item.domain.startsWith("."),
      ...(item.sameSite === undefined ? {} : { sameSite: String(item.sameSite).toLowerCase() as "strict" | "lax" | "none" })
    });
    if (!eligible(cookie)) throw new DeveloperError("invalid_session");
    try { jar.setCookieSync(cookie, DEVELOPER_BASE_URL); } catch { throw new DeveloperError("invalid_session"); }
  }
  return jar;
}

export function checkDeveloperPrivateParents(file: string, create: boolean): void {
  assertDeveloperPlatform();
  const parent = dirname(file);
  const parts = parent.slice(parse(parent).root.length).split(sep).filter(Boolean);
  let current = parse(parent).root;
  for (const part of parts) {
    current = join(current, part);
    if (create && current === parent) {
      if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
      const containing = openSync(dirname(current), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(containing); } finally { closeSync(containing); }
    }
    const st = lstatSync(current);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new DeveloperError("unsafe_session_store");
  }
  const st = lstatSync(parent);
  if (st.uid !== process.getuid!() || (st.mode & 0o077) !== 0) {
    throw new DeveloperError("unsafe_session_store");
  }
}

export function checkDeveloperPrivateFile(st: Stats): void {
  if (!st.isFile() || st.nlink !== 1 ||
    st.uid !== process.getuid!() || (st.mode & 0o077) !== 0 ||
    st.size > 1024 * 1024) throw new DeveloperError("unsafe_session_store");
}

export function readDeveloperPrivateInput(file: string): unknown {
  assertDeveloperPlatform();
  let fd: number | undefined;
  try {
    const target = resolve(file);
    checkDeveloperPrivateParents(target, false);
    if (lstatSync(target).isSymbolicLink()) throw new DeveloperError("unsafe_session_store");
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    checkDeveloperPrivateFile(fstatSync(fd));
    return JSON.parse(readFileSync(fd, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof DeveloperError) throw error;
    throw new DeveloperError("invalid_session");
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Opaque credential container: JSON serialization never includes cookies. */
export class DeveloperSession {
  #jar: CookieJar;
  #file: string;
  #snapshot: string;
  constructor(readonly teamId: string, jar: CookieJar, file: string, snapshot: string) {
    this.#jar = jar;
    this.#file = file;
    this.#snapshot = snapshot;
  }

  cookieHeader(path: DeveloperReadPath): string {
    assertDeveloperPlatform();
    const header = this.#jar.getCookieStringSync(developerReadUrl(path));
    if (!header) throw new DeveloperError("session_expired");
    return header;
  }

  refresh(path: DeveloperReadPath, values: string[]): void {
    developerReadUrl(path);
    this[developerTransportAccess](path, values);
  }

  [developerTransportAccess](path: DeveloperTransportPath, values?: string[]): string {
    assertDeveloperPlatform();
    const url = developerTransportUrl(path);
    if (path.startsWith("account/auth/key/download?") && !path.startsWith(`account/auth/key/download?teamId=${this.teamId}&`)) {
      throw new DeveloperError("team_mismatch");
    }
    if (values === undefined) {
      const header = this.#jar.getCookieStringSync(url);
      if (!header) throw new DeveloperError("session_expired");
      return header;
    }
    if (values.length === 0) return "";
    const candidate = CookieJar.deserializeSync(this.#jar.serializeSync()!);
    for (const value of values) {
      try {
        const cookie = Cookie.parse(value);
        if (!cookie || !cookie.secure) throw new DeveloperError("invalid_response");
        const accepted = candidate.setCookieSync(cookie, url);
        if (!accepted || !eligible(accepted, true)) throw new DeveloperError("invalid_response");
      } catch { throw new DeveloperError("invalid_response"); }
    }
    const serialized = encode(this.teamId, candidate);
    const lock = acquireDeveloperPrivateLock(this.#file);
    try {
      // A private, non-symlink parent and unchanged original are required even for refresh.
      const original = readDeveloperPrivateInput(this.#file);
      if (JSON.stringify(original) !== this.#snapshot) throw new DeveloperError("unsafe_session_store");
      writeDeveloperPrivateStore(this.#file, serialized, true);
    } catch { throw new DeveloperError("unsafe_session_store"); }
    finally { releaseDeveloperPrivateLock(lock); }
    this.#jar = candidate;
    this.#snapshot = serialized;
    return "";
  }
}

export interface DeveloperPrivateLock {
  path: string;
  fd: number;
}

export function acquireDeveloperPrivateLock(file: string): DeveloperPrivateLock {
  const path = `${file}.refresh.lock`;
  try {
    checkDeveloperPrivateParents(path, false);
    return {
      path,
      fd: openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DeveloperError("session_store_busy");
    throw new DeveloperError("unsafe_session_store");
  }
}

export function releaseDeveloperPrivateLock(lock: DeveloperPrivateLock): void {
  removeDeveloperOwnedFile(lock);
}

export function verifyDeveloperPrivateLock(lock: DeveloperPrivateLock): void {
  checkDeveloperPrivateParents(lock.path, false);
  const acquired = fstatSync(lock.fd);
  const current = lstatSync(lock.path);
  checkDeveloperPrivateFile(acquired);
  checkDeveloperPrivateFile(current);
  if (current.dev !== acquired.dev || current.ino !== acquired.ino) throw new DeveloperError("unsafe_session_store");
}

export function syncDeveloperPrivateDirectory(file: string): void {
  checkDeveloperPrivateParents(file, false);
  const directory = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function removeDeveloperOwnedFile(lock: DeveloperPrivateLock): void {
  try {
    // Keep the acquired descriptor open so its inode cannot be reused by another owner.
    verifyDeveloperPrivateLock(lock);
    unlinkSync(lock.path);
  } catch { throw new DeveloperError("unsafe_session_store"); }
  finally { closeSync(lock.fd); }
}

function encode(teamId: string, jar: CookieJar): string {
  return JSON.stringify({ version: 1, teamId, jar: jar.serializeSync() });
}

export function writeDeveloperPrivateStore(file: string, data: string, replace: boolean): void {
  assertDeveloperPlatform();
  checkDeveloperPrivateParents(file, true);
  if (replace) {
    if (lstatSync(file).isSymbolicLink()) throw new DeveloperError("unsafe_session_store");
    checkDeveloperPrivateFile(lstatSync(file));
  }
  // Same-directory atomic publication. Exclusive linking never clobbers an enrollment destination.
  const staging = join(dirname(file), `.developer-session-${randomUUID()}.json`);
  let fd: number | undefined;
  let acquired: Stats | undefined;
  try {
    fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    acquired = fstatSync(fd);
    writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (replace) renameSync(staging, file);
    else linkSync(staging, file);
    syncDeveloperPrivateDirectory(file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (acquired && existsSync(staging)) {
      const current = lstatSync(staging);
      if (current.dev !== acquired.dev || current.ino !== acquired.ino || !current.isFile()) {
        throw new DeveloperError("unsafe_session_store");
      }
      unlinkSync(staging);
    }
  }
}

export function importDeveloperSession(options: { teamId: string; input: unknown; sessionFile: string }): DeveloperSession {
  assertDeveloperPlatform();
  validateDeveloperId(options.teamId);
  const jar = enrollmentJar(options.input, options.teamId);
  const file = resolve(options.sessionFile);
  const serialized = encode(options.teamId, jar);
  try {
    writeDeveloperPrivateStore(file, serialized, false);
  } catch (error) {
    if (error instanceof DeveloperError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DeveloperError("session_exists");
    throw new DeveloperError("unsafe_session_store");
  }
  return new DeveloperSession(options.teamId, jar, file, serialized);
}

export function loadDeveloperSession(options: { teamId: string; sessionFile: string }): DeveloperSession {
  assertDeveloperPlatform();
  validateDeveloperId(options.teamId);
  const file = resolve(options.sessionFile);
  const stored = readDeveloperPrivateInput(file);
  if (!record(stored) || stored.teamId !== options.teamId) throw new DeveloperError("team_mismatch");
  if (stored.version !== 1 || !record(stored.jar)) throw new DeveloperError("invalid_session");
  try {
    const jar = CookieJar.deserializeSync(JSON.stringify(stored.jar));
    const all = jar.serializeSync()!.cookies;
    if (all.some(value => {
      const cookie = Cookie.fromJSON(value);
      return !cookie || !eligible(cookie, true);
    })) throw new DeveloperError("invalid_session");
    return new DeveloperSession(options.teamId, jar, file, JSON.stringify(stored));
  } catch { throw new DeveloperError("invalid_session"); }
}

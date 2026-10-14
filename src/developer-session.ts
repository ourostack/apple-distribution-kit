import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Cookie, CookieJar } from "tough-cookie";
import { createRequiresHuman, type RequiresHuman } from "./plan.js";

export const DEVELOPER_BASE_URL = "https://developer.apple.com/services-account/QH65B2/";
export type DeveloperReadPath = "account/auth/key/list" | "account/auth/key/get";
export type DeveloperErrorCode =
  | "invalid_arguments" | "invalid_session" | "unsafe_session_store" | "session_exists"
  | "team_mismatch" | "session_expired" | "sign_in_required" | "permission_denied"
  | "redirect_rejected" | "network_error" | "http_error" | "apple_error"
  | "invalid_response" | "pagination_non_progress" | "pagination_limit";

export class DeveloperError extends Error {
  readonly requiresHuman?: RequiresHuman;
  constructor(readonly code: DeveloperErrorCode) {
    super(`Developer inspection failed (${code}).`);
    this.name = "DeveloperError";
    if (code === "session_expired" || code === "sign_in_required") {
      this.requiresHuman = createRequiresHuman({
        code: "developer_sign_in_required",
        message: "Sign in to Apple Developer manually, then enroll a refreshed session.",
        url: "https://developer.apple.com/account/"
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

export function validateDeveloperId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Z0-9]{10}$/.test(value)) throw new DeveloperError("invalid_arguments");
}

export function developerReadUrl(path: DeveloperReadPath): string {
  if (path !== "account/auth/key/list" && path !== "account/auth/key/get") throw new DeveloperError("invalid_arguments");
  return DEVELOPER_BASE_URL + path;
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

function checkParents(file: string, create: boolean): void {
  const parent = dirname(file);
  const parts = parent.slice(parse(parent).root.length).split(sep).filter(Boolean);
  let current = parse(parent).root;
  for (const part of parts) {
    current = join(current, part);
    if (create && current === parent && !existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const st = lstatSync(current);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new DeveloperError("unsafe_session_store");
  }
  const st = lstatSync(parent);
  if (process.platform !== "win32" && (st.uid !== process.getuid!() || (st.mode & 0o077) !== 0)) {
    throw new DeveloperError("unsafe_session_store");
  }
}

function checkFile(st: Stats): void {
  if (!st.isFile() || st.nlink !== 1 ||
    (process.platform !== "win32" && (st.uid !== process.getuid!() || (st.mode & 0o077) !== 0)) ||
    st.size > 1024 * 1024) throw new DeveloperError("unsafe_session_store");
}

export function readDeveloperPrivateInput(file: string): unknown {
  let fd: number | undefined;
  try {
    const target = resolve(file);
    checkParents(target, false);
    if (lstatSync(target).isSymbolicLink()) throw new DeveloperError("unsafe_session_store");
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    checkFile(fstatSync(fd));
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
    const header = this.#jar.getCookieStringSync(developerReadUrl(path));
    if (!header) throw new DeveloperError("session_expired");
    return header;
  }

  refresh(path: DeveloperReadPath, values: string[]): void {
    const url = developerReadUrl(path);
    if (values.length === 0) return;
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
    try {
      // A private, non-symlink parent and unchanged original are required even for refresh.
      const original = readDeveloperPrivateInput(this.#file);
      if (JSON.stringify(original) !== this.#snapshot) throw new DeveloperError("unsafe_session_store");
      writeStore(this.#file, serialized, true);
    } catch { throw new DeveloperError("unsafe_session_store"); }
    this.#jar = candidate;
    this.#snapshot = serialized;
  }
}

function encode(teamId: string, jar: CookieJar): string {
  return JSON.stringify({ version: 1, teamId, jar: jar.serializeSync() });
}

function writeStore(file: string, data: string, replace: boolean): void {
  checkParents(file, true);
  // Same-directory atomic publication. Exclusive linking never clobbers an enrollment destination.
  const staging = join(dirname(file), `.developer-session-${randomUUID()}.json`);
  let fd: number | undefined;
  try {
    fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (replace) renameSync(staging, file);
    else linkSync(staging, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(staging)) unlinkSync(staging);
  }
}

export function importDeveloperSession(options: { teamId: string; input: unknown; sessionFile: string }): DeveloperSession {
  validateDeveloperId(options.teamId);
  const jar = enrollmentJar(options.input, options.teamId);
  const file = resolve(options.sessionFile);
  const serialized = encode(options.teamId, jar);
  try {
    writeStore(file, serialized, false);
  } catch (error) {
    if (error instanceof DeveloperError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DeveloperError("session_exists");
    throw new DeveloperError("unsafe_session_store");
  }
  return new DeveloperSession(options.teamId, jar, file, serialized);
}

export function loadDeveloperSession(options: { teamId: string; sessionFile: string }): DeveloperSession {
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

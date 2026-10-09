import { randomBytes, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AppStoreConnectClient } from "./asc.js";
import type { RawCommandResult } from "./xcode-runner.js";

/**
 * Long-lived CI signing.
 *
 * Ephemeral CI runners start with an empty keychain. When `xcodebuild -allowProvisioningUpdates` runs there with an App
 * Store Connect API key, Xcode mints a new "Created via API" development certificate on every run. These helpers replace
 * that with one long-lived certificate stored as CI secrets: the kit imports it into a temporary keychain, fetches or
 * creates matching provisioning profiles through the App Store Connect API, and writes manual-signing settings that
 * `xcodebuild` can use without talking to Apple. `revokeApiDevelopmentCertificates` stays as a safety net that should
 * normally find nothing.
 */

export type SigningExec = (argv: string[]) => Promise<RawCommandResult>;

export const DEFAULT_CERTIFICATE_SECRET_ENV = "APPLE_DISTRIBUTION_CERTIFICATE_P12_BASE64";
export const DEFAULT_CERTIFICATE_PASSWORD_ENV = "APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD";
export const DEFAULT_PROFILE_NAME_PREFIX = "ADK CI";
export const API_CREATED_CERTIFICATE_NAME = "created via api";
export const DEVELOPMENT_CERTIFICATE_TYPES = ["DEVELOPMENT", "IOS_DEVELOPMENT", "MAC_APP_DEVELOPMENT"] as const;

export class SigningError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SigningError";
    this.code = code;
  }
}

export interface CertificateSummary {
  id: string;
  certificateType: string;
  name: string;
  serialNumber: string;
  expirationDate: string;
}

export interface CreatedSigningCertificate extends CertificateSummary {
  p12Base64Path: string;
  passwordPath: string;
}

export interface SigningIdentity {
  sha1: string;
  name: string;
  serialNumber: string;
  notAfter: string;
}

export interface SigningState {
  keychainPath: string;
  identities: SigningIdentity[];
}

export interface InstalledProfile {
  bundleIdentifier: string;
  name: string;
  uuid: string;
  id: string;
  profileType: string;
  expirationDate: string;
  created: boolean;
  paths: string[];
}

export interface ProfileResult {
  certificate: CertificateSummary;
  profiles: InstalledProfile[];
  deletedProfileIds: string[];
}

export interface RevokeResult {
  found: number;
  eligible: CertificateSummary[];
  kept: CertificateSummary[];
  revoked: CertificateSummary[];
  dryRun: boolean;
  lines: string[];
}

type JsonRecord = Record<string, unknown>;

export function defaultProfileInstallDirs(home: string = homedir()): string[] {
  return [
    join(home, "Library", "MobileDevice", "Provisioning Profiles"),
    join(home, "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles")
  ];
}

/**
 * Creates a certificate through the App Store Connect API and packs it with a new private key into a password-protected
 * p12. Only two files are left with content: `<outDir>/certificate.p12.base64` and `<outDir>/certificate.password`.
 * Every intermediate file (private key, CSR, DER, PEM, binary p12) is truncated. Nothing secret is returned.
 */
export async function createSigningCertificate(input: {
  client: AppStoreConnectClient;
  exec: SigningExec;
  outDir: string;
  certificateType?: string;
  commonName?: string;
  openssl?: string;
  random?: (size: number) => Buffer;
}): Promise<CreatedSigningCertificate> {
  const openssl = input.openssl ?? "openssl";
  const certificateType = input.certificateType ?? "DISTRIBUTION";
  const random = input.random ?? randomBytes;
  mkdirSync(input.outDir, { recursive: true, mode: 0o700 });
  const paths = {
    key: join(input.outDir, "private-key.pem"),
    csr: join(input.outDir, "request.csr"),
    der: join(input.outDir, "certificate.der"),
    pem: join(input.outDir, "certificate.pem"),
    p12: join(input.outDir, "certificate.p12"),
    password: join(input.outDir, "certificate.password"),
    p12Base64: join(input.outDir, "certificate.p12.base64")
  };
  writeFileSync(paths.password, random(24).toString("base64url"), { mode: 0o600 });
  // Create every output owner-only first; openssl keeps an existing file's mode when it overwrites it.
  [paths.key, paths.csr, paths.pem, paths.p12].forEach((path) => writeFileSync(path, "", { mode: 0o600 }));
  try {
    await run(input.exec, [openssl, "genrsa", "-out", paths.key, "2048"]);
    await run(input.exec, [openssl, "req", "-new", "-key", paths.key, "-subj", `/CN=${input.commonName ?? "apple-distribution-kit CI"}`, "-out", paths.csr]);
    const response = await input.client.request({
      method: "POST",
      path: "/v1/certificates",
      body: {
        data: {
          type: "certificates",
          attributes: { certificateType, csrContent: readFileSync(paths.csr, "utf8") }
        }
      }
    });
    const resource = record(record(response).data);
    const content = stringField(record(resource.attributes), "certificateContent");
    writeFileSync(paths.der, Buffer.from(content, "base64"), { mode: 0o600 });
    await run(input.exec, [openssl, "x509", "-inform", "DER", "-in", paths.der, "-out", paths.pem]);
    await run(input.exec, [
      openssl,
      "pkcs12",
      "-export",
      "-inkey",
      paths.key,
      "-in",
      paths.pem,
      "-out",
      paths.p12,
      "-passout",
      `file:${paths.password}`,
      "-keypbe",
      "PBE-SHA1-3DES",
      "-certpbe",
      "PBE-SHA1-3DES",
      "-macalg",
      "sha1"
    ]);
    writeFileSync(paths.p12Base64, readFileSync(paths.p12).toString("base64"), { mode: 0o600 });
    return { ...summarizeCertificate(resource), p12Base64Path: paths.p12Base64, passwordPath: paths.password };
  } finally {
    [paths.key, paths.csr, paths.der, paths.pem, paths.p12].forEach(truncate);
  }
}

/**
 * Imports a base64 p12 into a new, unlocked temporary keychain and adds that keychain to the user search list so
 * `codesign` and `xcodebuild` can find it. The decoded p12 is truncated after import.
 */
export async function importSigningIdentity(input: {
  exec: SigningExec;
  p12Base64: string;
  p12Password: string;
  keychainPath: string;
  random?: (size: number) => Buffer;
}): Promise<SigningState> {
  const random = input.random ?? randomBytes;
  const keychainPassword = random(24).toString("base64url");
  const p12 = Buffer.from(input.p12Base64.replace(/\s+/g, ""), "base64");
  if (p12.length === 0) {
    throw new SigningError("empty_certificate", "The signing certificate secret is empty or not base64.");
  }
  mkdirSync(dirname(input.keychainPath), { recursive: true, mode: 0o700 });
  const p12Path = join(dirname(input.keychainPath), `${basename(input.keychainPath)}.import.p12`);
  writeFileSync(p12Path, p12, { mode: 0o600 });
  try {
    await run(input.exec, ["security", "create-keychain", "-p", keychainPassword, input.keychainPath]);
    await run(input.exec, ["security", "set-keychain-settings", "-lut", "21600", input.keychainPath]);
    await run(input.exec, ["security", "unlock-keychain", "-p", keychainPassword, input.keychainPath]);
    await run(input.exec, [
      "security",
      "import",
      p12Path,
      "-k",
      input.keychainPath,
      "-P",
      input.p12Password,
      "-f",
      "pkcs12",
      "-T",
      "/usr/bin/codesign",
      "-T",
      "/usr/bin/security",
      "-T",
      "/usr/bin/productbuild"
    ]);
    await run(input.exec, [
      "security",
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      keychainPassword,
      input.keychainPath
    ]);
  } finally {
    truncate(p12Path);
  }
  const existing = parseKeychainList(await run(input.exec, ["security", "list-keychains", "-d", "user"])).filter(
    (path) => path !== input.keychainPath
  );
  await run(input.exec, ["security", "list-keychains", "-d", "user", "-s", input.keychainPath, ...existing]);
  const identities = parseIdentities(
    await run(input.exec, ["security", "find-identity", "-v", "-p", "codesigning", input.keychainPath]),
    await run(input.exec, ["security", "find-certificate", "-a", "-p", input.keychainPath])
  );
  if (identities.length === 0) {
    throw new SigningError("no_identity", "The imported p12 did not produce a valid code signing identity.");
  }
  return { keychainPath: input.keychainPath, identities };
}

export async function deleteSigningKeychain(input: { exec: SigningExec; keychainPath: string }): Promise<void> {
  await run(input.exec, ["security", "delete-keychain", input.keychainPath]);
}

export function parseKeychainList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim().replace(/^"(.*)"$/, "$1"))
    .filter((line) => line !== "");
}

export function parseIdentities(findIdentityStdout: string, pemStdout: string): SigningIdentity[] {
  const certificates = new Map<string, X509Certificate>();
  for (const pem of pemStdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []) {
    const certificate = new X509Certificate(pem);
    certificates.set(certificate.fingerprint.replace(/:/g, "").toUpperCase(), certificate);
  }
  const identities: SigningIdentity[] = [];
  for (const match of findIdentityStdout.matchAll(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"\s*$/gm)) {
    const sha1 = match[1]!.toUpperCase();
    const certificate = certificates.get(sha1);
    if (!certificate) {
      continue;
    }
    identities.push({
      sha1,
      name: match[2]!,
      serialNumber: normalizeSerial(certificate.serialNumber),
      notAfter: new Date(certificate.validTo).toISOString()
    });
  }
  return identities;
}

export function normalizeSerial(serial: string): string {
  return serial.replace(/[^0-9A-Fa-f]/g, "").replace(/^0+(?=.)/, "").toUpperCase();
}

export function selectIdentity(state: SigningState, sha1?: string): SigningIdentity {
  if (sha1) {
    const identity = state.identities.find((candidate) => candidate.sha1 === sha1.toUpperCase());
    if (!identity) {
      throw new SigningError("identity_not_found", `No imported identity has SHA-1 ${sha1}.`);
    }
    return identity;
  }
  if (state.identities.length !== 1) {
    throw new SigningError("ambiguous_identity", `Expected one imported identity, found ${state.identities.length}; pass --identity-sha1.`);
  }
  return state.identities[0]!;
}

/**
 * Finds or creates one provisioning profile per bundle identifier for the given certificate, and writes each profile
 * into the install directories. Profiles are named `<prefix> <bundle id> <certificate id>`, so a renewed certificate
 * gets fresh profiles and stale kit-owned profiles with the same name are deleted. Only GET requests are made when every
 * profile is already active.
 */
export async function ensureProvisioningProfiles(input: {
  client: AppStoreConnectClient;
  certificateSerial: string;
  bundleIdentifiers: string[];
  installDirs: string[];
  profileType?: string;
  namePrefix?: string;
  minimumValidityDays?: number;
  now?: Date;
}): Promise<ProfileResult> {
  const profileType = input.profileType ?? "IOS_APP_STORE";
  const prefix = input.namePrefix ?? DEFAULT_PROFILE_NAME_PREFIX;
  const minimumValidMs = (input.minimumValidityDays ?? 7) * 24 * 60 * 60 * 1000;
  const now = (input.now ?? new Date()).getTime();
  const serial = normalizeSerial(input.certificateSerial);
  const certificate = (await listAll(input.client, "/v1/certificates", { limit: "200" })).find(
    (resource) => normalizeSerial(String(record(resource.attributes).serialNumber ?? "")) === serial
  );
  if (!certificate) {
    throw new SigningError(
      "certificate_not_found",
      `No App Store Connect certificate has serial ${serial}. It may have been revoked; create a new one with "signing create-certificate".`
    );
  }
  const certificateSummary = summarizeCertificate(certificate);
  const profiles: InstalledProfile[] = [];
  const deletedProfileIds: string[] = [];
  for (const bundleIdentifier of input.bundleIdentifiers) {
    const bundle = (await listAll(input.client, "/v1/bundleIds", { "filter[identifier]": bundleIdentifier, limit: "200" })).find(
      (resource) => record(resource.attributes).identifier === bundleIdentifier
    );
    if (!bundle) {
      throw new SigningError("bundle_id_not_found", `No App Store Connect bundle ID is registered for ${bundleIdentifier}.`);
    }
    const name = `${prefix} ${bundleIdentifier} ${certificateSummary.id}`;
    const existing = (
      await listAll(input.client, "/v1/profiles", { "filter[name]": name, "filter[profileType]": profileType, limit: "200" })
    ).filter((resource) => record(resource.attributes).name === name);
    let profile = existing.find((resource) => {
      const attributes = record(resource.attributes);
      return (
        attributes.profileState === "ACTIVE" &&
        typeof attributes.profileContent === "string" &&
        Date.parse(String(attributes.expirationDate)) - now > minimumValidMs
      );
    });
    for (const stale of existing.filter((resource) => resource !== profile)) {
      await input.client.request({ method: "DELETE", path: `/v1/profiles/${encodeURIComponent(String(stale.id))}` });
      deletedProfileIds.push(String(stale.id));
    }
    const created = !profile;
    if (!profile) {
      profile = record(
        record(
          await input.client.request({
            method: "POST",
            path: "/v1/profiles",
            body: {
              data: {
                type: "profiles",
                attributes: { name, profileType },
                relationships: {
                  bundleId: { data: { type: "bundleIds", id: bundle.id } },
                  certificates: { data: [{ type: "certificates", id: certificateSummary.id }] }
                }
              }
            }
          })
        ).data
      );
    }
    const attributes = record(profile.attributes);
    const uuid = stringField(attributes, "uuid");
    const content = Buffer.from(stringField(attributes, "profileContent"), "base64");
    const paths = input.installDirs.map((dir) => {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${uuid}.mobileprovision`);
      writeFileSync(path, content);
      return path;
    });
    profiles.push({
      bundleIdentifier,
      name,
      uuid,
      id: String(profile.id),
      profileType,
      expirationDate: String(attributes.expirationDate),
      created,
      paths
    });
  }
  return { certificate: certificateSummary, profiles, deletedProfileIds };
}

/** Converts a bundle identifier the same way Xcode's `:c99extidentifier` build setting operator does. */
export function c99ExtIdentifier(value: string): string {
  const replaced = value.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(replaced) ? `_${replaced}` : replaced;
}

/**
 * Renders an xcconfig for `xcodebuild -xcconfig`. It switches every target to manual signing with the imported identity
 * and picks each target's profile by its bundle identifier, so app extensions get their own profile. Targets without a
 * listed bundle identifier (for example Swift package products) resolve to an empty profile specifier.
 */
export function renderSigningXcconfig(input: {
  teamId: string;
  identity: SigningIdentity;
  keychainPath: string;
  profiles: Array<{ bundleIdentifier: string; name: string }>;
}): string {
  const lines = [
    "// Generated by apple-distribution-kit signing profiles. Do not commit.",
    "CODE_SIGN_STYLE = Manual",
    `DEVELOPMENT_TEAM = ${input.teamId}`,
    `CODE_SIGN_IDENTITY = ${input.identity.sha1}`,
    `OTHER_CODE_SIGN_FLAGS = $(inherited) --keychain "${input.keychainPath}"`,
    ...input.profiles.map((profile) => `ADK_PROFILE_${c99ExtIdentifier(profile.bundleIdentifier)} = ${profile.name}`),
    "PROVISIONING_PROFILE_SPECIFIER = $(ADK_PROFILE_$(PRODUCT_BUNDLE_IDENTIFIER:c99extidentifier))",
    ""
  ];
  return lines.join("\n");
}

export function buildExportOptions(input: {
  base: JsonRecord;
  teamId: string;
  identity: SigningIdentity;
  profiles: Array<{ bundleIdentifier: string; name: string }>;
}): JsonRecord {
  return {
    ...input.base,
    signingStyle: "manual",
    teamID: input.teamId,
    signingCertificate: input.identity.sha1,
    provisioningProfiles: Object.fromEntries(input.profiles.map((profile) => [profile.bundleIdentifier, profile.name]))
  };
}

export async function readPlistJson(exec: SigningExec, path: string): Promise<JsonRecord> {
  return record(JSON.parse(await run(exec, ["plutil", "-convert", "json", "-o", "-", path])));
}

export async function writePlist(exec: SigningExec, path: string, value: JsonRecord): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  await run(exec, ["plutil", "-convert", "xml1", path]);
}

/**
 * Safety net: revokes development certificates that Xcode automatic signing created through an API key. Only
 * development certificates named exactly "Created via API" qualify; distribution, Developer ID and Mac certificates and
 * certificates made by people are never touched.
 */
export async function revokeApiDevelopmentCertificates(input: {
  client: AppStoreConnectClient;
  dryRun?: boolean;
}): Promise<RevokeResult> {
  const dryRun = input.dryRun ?? false;
  const certificates = (await listAll(input.client, "/v1/certificates", { limit: "200" })).map(summarizeCertificate);
  const eligible = certificates.filter(isApiCreatedDevelopmentCertificate);
  const kept = certificates.filter((certificate) => !eligible.includes(certificate));
  const lines = [`Found ${certificates.length} certificate(s); ${eligible.length} created via API and eligible for revocation.`];
  kept.forEach((certificate) => lines.push(`keep: ${describeCertificate(certificate)}`));
  const revoked: CertificateSummary[] = [];
  for (const certificate of eligible) {
    if (dryRun) {
      lines.push(`would revoke: ${describeCertificate(certificate)}`);
      continue;
    }
    await input.client.request({ method: "DELETE", path: `/v1/certificates/${encodeURIComponent(certificate.id)}` });
    revoked.push(certificate);
    lines.push(`revoked: ${describeCertificate(certificate)}`);
  }
  lines.push(
    eligible.length === 0
      ? 'Nothing to revoke: no "Created via API" development certificates exist.'
      : `Revoked ${revoked.length} certificate(s)${dryRun ? " (dry run)" : ""}.`
  );
  return { found: certificates.length, eligible, kept, revoked, dryRun, lines };
}

export function isApiCreatedDevelopmentCertificate(certificate: CertificateSummary): boolean {
  return (
    (DEVELOPMENT_CERTIFICATE_TYPES as readonly string[]).includes(certificate.certificateType) &&
    certificate.name.trim().toLowerCase() === API_CREATED_CERTIFICATE_NAME
  );
}

export function describeCertificate(certificate: CertificateSummary): string {
  return `id=${certificate.id} type=${certificate.certificateType} name=${JSON.stringify(certificate.name)} serial=${certificate.serialNumber} expires=${certificate.expirationDate}`;
}

function summarizeCertificate(resource: JsonRecord): CertificateSummary {
  const attributes = record(resource.attributes);
  const name = [attributes.name, attributes.displayName].find(
    (label): label is string => typeof label === "string" && label.trim().toLowerCase() === API_CREATED_CERTIFICATE_NAME
  );
  return {
    id: String(resource.id),
    certificateType: String(attributes.certificateType),
    name: name ?? String(attributes.name ?? attributes.displayName ?? ""),
    serialNumber: normalizeSerial(String(attributes.serialNumber ?? "")),
    expirationDate: String(attributes.expirationDate)
  };
}

async function listAll(client: AppStoreConnectClient, path: string, query: Record<string, string>): Promise<JsonRecord[]> {
  const resources: JsonRecord[] = [];
  let next: string | undefined = path;
  let nextQuery: Record<string, string> = query;
  while (next) {
    const body = record(await client.get(next, nextQuery));
    if (!Array.isArray(body.data)) {
      throw new SigningError("invalid_response", `App Store Connect GET ${path} did not return a data array.`);
    }
    resources.push(...body.data.map(record));
    const link = record(body.links ?? {}).next;
    next = typeof link === "string" && link !== "" ? link : undefined;
    nextQuery = {};
  }
  return resources;
}

async function run(exec: SigningExec, argv: string[]): Promise<string> {
  const result = await exec(argv);
  if (result.exitCode !== 0) {
    // Only the tool and subcommand are named: later arguments can carry keychain or p12 passwords.
    const detail = (result.stderr.trim() || result.stdout.trim()).split("\n")[0];
    throw new SigningError(
      "command_failed",
      `${argv.slice(0, 2).join(" ")} exited ${result.exitCode}${detail ? `: ${detail}` : ""}`
    );
  }
  return result.stdout;
}

function truncate(path: string): void {
  if (existsSync(path)) {
    writeFileSync(path, "");
  }
}

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SigningError("invalid_response", "Expected a JSON object.");
  }
  return value as JsonRecord;
}

function stringField(value: JsonRecord, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field === "") {
    throw new SigningError("invalid_response", `App Store Connect response is missing ${key}.`);
  }
  return field;
}

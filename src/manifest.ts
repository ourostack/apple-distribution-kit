import { readFile } from "node:fs/promises";

export type ApplePlatform = "macos" | "ios";
export type DistributionKind = "app-store" | "developer-id" | "testflight";

export interface AppleDistributionManifest {
  schemaVersion: 1;
  app: {
    name: string;
    bundleId: string;
    sku?: string;
    primaryLocale?: string;
  };
  team: {
    teamId: string;
    providerPublicId?: string;
  };
  channels: DistributionChannel[];
}

export interface DistributionChannel {
  id: string;
  platform: ApplePlatform;
  distribution: DistributionKind;
  bundleId: string;
  buildCommand: string;
  packageCommand: string;
  store?: StoreMetadata;
}

export interface StoreMetadata {
  version: string;
  copyright: string;
  category: string;
  screenshots?: string[];
  appPreviews?: string[];
  privacy?: {
    policyUrl: string;
    collectsData: boolean;
  };
  exportCompliance?: {
    usesEncryption: boolean;
    exempt: boolean;
  };
}

export interface ValidationError {
  path: string;
  message: string;
}

export type ManifestValidationResult =
  | { ok: true; manifest: AppleDistributionManifest }
  | { ok: false; errors: ValidationError[] };

export async function loadManifest(path: string): Promise<AppleDistributionManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const result = validateManifestObject(parsed);
  if (!result.ok) {
    throw new Error(`Invalid Apple distribution manifest: ${result.errors[0]?.path ?? "/"} ${result.errors[0]?.message ?? ""}`);
  }
  return result.manifest;
}

export function validateManifestObject(value: unknown): ManifestValidationResult {
  const errors: ValidationError[] = [];
  validateObject(value, "", errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, manifest: value as AppleDistributionManifest };
}

function validateObject(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isRecord(value)) {
    errors.push({ path: pointer(path), message: "Expected object" });
    return;
  }

  expectLiteral(value.schemaVersion, `${path}/schemaVersion`, 1, errors);
  validateApp(value.app, `${path}/app`, errors);
  validateTeam(value.team, `${path}/team`, errors);
  validateChannels(value.channels, `${path}/channels`, errors);
}

function validateApp(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isRecord(value)) {
    errors.push({ path: pointer(path), message: "Expected object" });
    return;
  }
  expectNonEmptyString(value.name, `${path}/name`, errors);
  expectNonEmptyString(value.bundleId, `${path}/bundleId`, errors);
  expectOptionalNonEmptyString(value.sku, `${path}/sku`, errors);
  expectOptionalNonEmptyString(value.primaryLocale, `${path}/primaryLocale`, errors);
}

function validateTeam(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isRecord(value)) {
    errors.push({ path: pointer(path), message: "Expected object" });
    return;
  }
  expectNonEmptyString(value.teamId, `${path}/teamId`, errors);
  expectOptionalNonEmptyString(value.providerPublicId, `${path}/providerPublicId`, errors);
}

function validateChannels(value: unknown, path: string, errors: ValidationError[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path: pointer(path), message: "Expected non-empty array" });
    return;
  }
  value.forEach((channel, index) => validateChannel(channel, `${path}/${index}`, errors));
}

function validateChannel(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isRecord(value)) {
    errors.push({ path: pointer(path), message: "Expected object" });
    return;
  }
  expectNonEmptyString(value.id, `${path}/id`, errors);
  expectEnum(value.platform, `${path}/platform`, ["macos", "ios"], errors);
  expectEnum(value.distribution, `${path}/distribution`, ["app-store", "developer-id", "testflight"], errors);
  expectNonEmptyString(value.bundleId, `${path}/bundleId`, errors);
  expectNonEmptyString(value.buildCommand, `${path}/buildCommand`, errors);
  expectNonEmptyString(value.packageCommand, `${path}/packageCommand`, errors);
  if (value.store !== undefined) {
    validateStore(value.store, `${path}/store`, errors);
  }
}

function validateStore(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isRecord(value)) {
    errors.push({ path: pointer(path), message: "Expected object" });
    return;
  }
  expectNonEmptyString(value.version, `${path}/version`, errors);
  expectNonEmptyString(value.copyright, `${path}/copyright`, errors);
  expectNonEmptyString(value.category, `${path}/category`, errors);
  expectOptionalStringArray(value.screenshots, `${path}/screenshots`, errors);
  expectOptionalStringArray(value.appPreviews, `${path}/appPreviews`, errors);
  if (value.privacy !== undefined) {
    validatePrivacy(value.privacy, `${path}/privacy`, errors);
  }
  if (value.exportCompliance !== undefined) {
    validateExportCompliance(value.exportCompliance, `${path}/exportCompliance`, errors);
  }
}

function validatePrivacy(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isRecord(value)) {
    errors.push({ path: pointer(path), message: "Expected object" });
    return;
  }
  expectNonEmptyString(value.policyUrl, `${path}/policyUrl`, errors);
  expectBoolean(value.collectsData, `${path}/collectsData`, errors);
}

function validateExportCompliance(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isRecord(value)) {
    errors.push({ path: pointer(path), message: "Expected object" });
    return;
  }
  expectBoolean(value.usesEncryption, `${path}/usesEncryption`, errors);
  expectBoolean(value.exempt, `${path}/exempt`, errors);
}

function expectLiteral(value: unknown, path: string, expected: unknown, errors: ValidationError[]): void {
  if (value !== expected) {
    errors.push({ path: pointer(path), message: `Expected ${String(expected)}` });
  }
}

function expectEnum(value: unknown, path: string, allowed: string[], errors: ValidationError[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push({ path: pointer(path), message: `Expected one of: ${allowed.join(", ")}` });
  }
}

function expectNonEmptyString(value: unknown, path: string, errors: ValidationError[]): void {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({ path: pointer(path), message: "Expected non-empty string" });
  }
}

function expectOptionalNonEmptyString(value: unknown, path: string, errors: ValidationError[]): void {
  if (value !== undefined) {
    expectNonEmptyString(value, path, errors);
  }
}

function expectOptionalStringArray(value: unknown, path: string, errors: ValidationError[]): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push({ path: pointer(path), message: "Expected array of non-empty strings" });
    return;
  }
  value.forEach((entry, index) => expectNonEmptyString(entry, `${path}/${index}`, errors));
}

function expectBoolean(value: unknown, path: string, errors: ValidationError[]): void {
  if (typeof value !== "boolean") {
    errors.push({ path: pointer(path), message: "Expected boolean" });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(path: string): string {
  return path === "" ? "/" : path;
}

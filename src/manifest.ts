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
  testflight?: TestFlightMetadata;
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

export interface TestFlightMetadata {
  groups: TestFlightGroup[];
  build?: {
    whatsNew?: string;
    autoNotifyEnabled?: boolean;
    notifyTesters?: boolean;
  };
  betaApp?: {
    description?: string;
    feedbackEmail?: string;
    marketingUrl?: string;
    privacyPolicyUrl?: string;
  };
  betaReview?: {
    contactFirstName?: string;
    contactLastName?: string;
    contactPhone?: string;
    contactEmail?: string;
    demoAccountRequired?: boolean;
    demoAccountName?: string;
    demoAccountPassword?: string;
    notes?: string;
  };
}

export interface TestFlightGroup {
  name: string;
  type?: "internal" | "external";
  hasAccessToAllBuilds?: boolean;
  publicLinkEnabled?: boolean;
  publicLinkLimitEnabled?: boolean;
  publicLinkLimit?: number;
  feedbackEnabled?: boolean;
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
    const firstError = result.errors[0]!;
    throw new Error(`Invalid Apple distribution manifest: ${firstError.path} ${firstError.message}`);
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
  const seenChannelIds = new Set<string>();
  value.forEach((channel, index) => {
    const channelPath = `${path}/${index}`;
    validateChannel(channel, channelPath, errors);
    if (!isRecord(channel)) {
      return;
    }

    if (typeof channel.id === "string" && channel.id.trim() !== "") {
      if (seenChannelIds.has(channel.id)) {
        errors.push({ path: pointer(`${channelPath}/id`), message: `Duplicate channel id: ${channel.id}` });
      }
      seenChannelIds.add(channel.id);
    }

    validateChannelSemantics(channel, channelPath, errors);
  });
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
  if (value.testflight !== undefined) {
    validateTestFlight(value.testflight, `${path}/testflight`, errors);
  }
}

function validateChannelSemantics(value: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  if (value.distribution === "app-store" && value.store === undefined) {
    errors.push({ path: pointer(`${path}/store`), message: "App Store channels require store metadata" });
  }
  if (value.distribution === "developer-id" && value.platform !== "macos") {
    errors.push({ path: pointer(`${path}/platform`), message: "Developer ID channels are only supported for macOS" });
  }
  if (value.distribution === "testflight" && value.platform !== "ios") {
    errors.push({ path: pointer(`${path}/platform`), message: "TestFlight channels are only supported for iOS" });
  }
  if (value.distribution === "testflight" && value.testflight === undefined) {
    errors.push({ path: pointer(`${path}/testflight`), message: "TestFlight channels require testflight metadata" });
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

function validateTestFlight(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isRecord(value)) {
    errors.push({ path: pointer(path), message: "Expected object" });
    return;
  }
  validateTestFlightGroups(value.groups, `${path}/groups`, errors);
  if (value.build !== undefined) {
    validateTestFlightBuild(value.build, `${path}/build`, errors);
  }
  if (value.betaApp !== undefined) {
    validateTestFlightStringBag(value.betaApp, `${path}/betaApp`, errors, [
      "description",
      "feedbackEmail",
      "marketingUrl",
      "privacyPolicyUrl"
    ]);
  }
  if (value.betaReview !== undefined) {
    validateTestFlightBetaReview(value.betaReview, `${path}/betaReview`, errors);
  }
}

function validateTestFlightGroups(value: unknown, path: string, errors: ValidationError[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path: pointer(path), message: "Expected non-empty array" });
    return;
  }
  const seenNames = new Set<string>();
  value.forEach((group, index) => {
    const groupPath = `${path}/${index}`;
    if (!isRecord(group)) {
      errors.push({ path: pointer(groupPath), message: "Expected object" });
      return;
    }
    expectNonEmptyString(group.name, `${groupPath}/name`, errors);
    if (typeof group.name === "string" && group.name.trim() !== "") {
      if (seenNames.has(group.name)) {
        errors.push({ path: pointer(`${groupPath}/name`), message: `Duplicate TestFlight group name: ${group.name}` });
      }
      seenNames.add(group.name);
    }
    expectOptionalEnum(group.type, `${groupPath}/type`, ["internal", "external"], errors);
    expectOptionalBoolean(group.hasAccessToAllBuilds, `${groupPath}/hasAccessToAllBuilds`, errors);
    expectOptionalBoolean(group.publicLinkEnabled, `${groupPath}/publicLinkEnabled`, errors);
    expectOptionalBoolean(group.publicLinkLimitEnabled, `${groupPath}/publicLinkLimitEnabled`, errors);
    expectOptionalIntegerRange(group.publicLinkLimit, `${groupPath}/publicLinkLimit`, 1, 10_000, errors);
    expectOptionalBoolean(group.feedbackEnabled, `${groupPath}/feedbackEnabled`, errors);
  });
}

function validateTestFlightBuild(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isRecord(value)) {
    errors.push({ path: pointer(path), message: "Expected object" });
    return;
  }
  expectOptionalNonEmptyString(value.whatsNew, `${path}/whatsNew`, errors);
  expectOptionalBoolean(value.autoNotifyEnabled, `${path}/autoNotifyEnabled`, errors);
  expectOptionalBoolean(value.notifyTesters, `${path}/notifyTesters`, errors);
}

function validateTestFlightStringBag(
  value: unknown,
  path: string,
  errors: ValidationError[],
  keys: string[]
): void {
  if (!isRecord(value)) {
    errors.push({ path: pointer(path), message: "Expected object" });
    return;
  }
  keys.forEach((key) => expectOptionalNonEmptyString(value[key], `${path}/${key}`, errors));
}

function validateTestFlightBetaReview(value: unknown, path: string, errors: ValidationError[]): void {
  validateTestFlightStringBag(value, path, errors, [
    "contactFirstName",
    "contactLastName",
    "contactPhone",
    "contactEmail",
    "demoAccountName",
    "demoAccountPassword",
    "notes"
  ]);
  if (isRecord(value)) {
    expectOptionalBoolean(value.demoAccountRequired, `${path}/demoAccountRequired`, errors);
  }
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

function expectOptionalEnum(value: unknown, path: string, allowed: string[], errors: ValidationError[]): void {
  if (value !== undefined) {
    expectEnum(value, path, allowed, errors);
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

function expectOptionalBoolean(value: unknown, path: string, errors: ValidationError[]): void {
  if (value !== undefined) {
    expectBoolean(value, path, errors);
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

function expectOptionalIntegerRange(
  value: unknown,
  path: string,
  min: number,
  max: number,
  errors: ValidationError[]
): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)) {
    errors.push({ path: pointer(path), message: `Expected integer between ${min} and ${max}` });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(path: string): string {
  return path === "" ? "/" : path;
}

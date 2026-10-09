import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createAppStoreConnectClient, loadAscAuth, type AppStoreConnectClient, type RetryOptions } from "./asc.js";
import { discoverConfigPath } from "./config.js";
import {
  buildExportOptions,
  createSigningCertificate,
  DEFAULT_CERTIFICATE_PASSWORD_ENV,
  DEFAULT_CERTIFICATE_SECRET_ENV,
  defaultProfileInstallDirs,
  deleteSigningKeychain,
  describeCertificate,
  ensureProvisioningProfiles,
  importSigningIdentity,
  readPlistJson,
  renderSigningXcconfig,
  revokeApiDevelopmentCertificates,
  selectIdentity,
  writePlist,
  type SigningExec,
  type SigningState
} from "./signing.js";

export interface SigningCliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export interface SigningCliDependencies {
  exec: SigningExec;
  env: Record<string, string | undefined>;
  createClient?: (configPath: string, retry: RetryOptions) => Promise<AppStoreConnectClient>;
  sleep?: (ms: number) => Promise<void>;
  homeDir?: string;
}

export const signingUsage = `  apple-distribution-kit signing create-certificate --out-dir <dir> [--certificate-type DISTRIBUTION] [--common-name <name>] [--openssl <path>] [--config <path>] [--json]
  apple-distribution-kit signing import --keychain <path> --state <path> [--p12-base64-env <name>] [--password-env <name>] [--json]
  apple-distribution-kit signing profiles --state <path> --team-id <id> --bundle-id <id> [--bundle-id <id>] --xcconfig <path> --export-options <path> [--export-options-base <path>] [--profile-type IOS_APP_STORE] [--install-dir <dir>] [--identity-sha1 <sha1>] [--name-prefix <text>] [--retries <n>] [--config <path>] [--json]
  apple-distribution-kit signing delete-keychain --keychain <path>
  apple-distribution-kit signing revoke-api-certificates [--dry-run] [--best-effort] [--retries <n>] [--config <path>] [--json]
`;

export async function signingCommand(
  io: SigningCliIo,
  json: boolean,
  args: string[],
  dependencies: SigningCliDependencies
): Promise<number> {
  const subcommand = args[1];
  const bestEffort = subcommand === "revoke-api-certificates" && args.includes("--best-effort");
  try {
    switch (subcommand) {
      case "create-certificate":
        return await createCertificateCommand(io, json, args, dependencies);
      case "import":
        return await importCommand(io, json, args, dependencies);
      case "profiles":
        return await profilesCommand(io, json, args, dependencies);
      case "delete-keychain":
        return await deleteKeychainCommand(io, json, args, dependencies);
      case "revoke-api-certificates":
        return await revokeCommand(io, json, args, dependencies);
      default:
        return fail(io, json, 64, "unknown_command", `Unknown signing command: ${subcommand}`);
    }
  } catch (error) {
    if (bestEffort) {
      io.stderr(`signing revoke-api-certificates warning: ${(error as Error).message}\n`);
      return 0;
    }
    return fail(io, json, error instanceof UsageError ? 64 : 69, error instanceof UsageError ? "missing_option" : "signing_failed", (error as Error).message);
  }
}

async function createCertificateCommand(io: SigningCliIo, json: boolean, args: string[], dependencies: SigningCliDependencies) {
  const outDir = required(args, "--out-dir");
  const client = await clientFor(io, args, dependencies);
  const openssl = optionValue(args, "--openssl");
  const certificateType = optionValue(args, "--certificate-type");
  const commonName = optionValue(args, "--common-name");
  const created = await createSigningCertificate({
    client,
    exec: dependencies.exec,
    outDir,
    ...(openssl ? { openssl } : {}),
    ...(certificateType ? { certificateType } : {}),
    ...(commonName ? { commonName } : {})
  });
  if (json) {
    io.stdout(`${JSON.stringify({ ok: true, certificate: created }, null, 2)}\n`);
  } else {
    io.stdout(
      `Created certificate ${describeCertificate(created)}\n` +
        `Store ${created.p12Base64Path} as ${DEFAULT_CERTIFICATE_SECRET_ENV} and ${created.passwordPath} as ${DEFAULT_CERTIFICATE_PASSWORD_ENV}, then truncate both files.\n`
    );
  }
  return 0;
}

async function importCommand(io: SigningCliIo, json: boolean, args: string[], dependencies: SigningCliDependencies) {
  const keychainPath = required(args, "--keychain");
  const statePath = required(args, "--state");
  const secretEnv = optionValue(args, "--p12-base64-env") ?? DEFAULT_CERTIFICATE_SECRET_ENV;
  const passwordEnv = optionValue(args, "--password-env") ?? DEFAULT_CERTIFICATE_PASSWORD_ENV;
  const missing = [secretEnv, passwordEnv].filter((name) => !dependencies.env[name]);
  if (missing.length > 0) {
    throw new UsageError(`Missing signing secret environment variable(s): ${missing.join(", ")}`);
  }
  const state = await importSigningIdentity({
    exec: dependencies.exec,
    p12Base64: dependencies.env[secretEnv]!,
    p12Password: dependencies.env[passwordEnv]!,
    keychainPath
  });
  writeJson(statePath, state);
  if (json) {
    io.stdout(`${JSON.stringify({ ok: true, state }, null, 2)}\n`);
  } else {
    io.stdout(`Imported ${state.identities.length} signing identity(ies) into ${keychainPath}; no certificate was created.\n`);
    state.identities.forEach((identity) =>
      io.stdout(`identity: ${JSON.stringify(identity.name)} sha1=${identity.sha1} serial=${identity.serialNumber} expires=${identity.notAfter}\n`)
    );
  }
  return 0;
}

async function profilesCommand(io: SigningCliIo, json: boolean, args: string[], dependencies: SigningCliDependencies) {
  const state = JSON.parse(readFileSync(required(args, "--state"), "utf8")) as SigningState;
  const teamId = required(args, "--team-id");
  const xcconfigPath = required(args, "--xcconfig");
  const exportOptionsPath = required(args, "--export-options");
  const bundleIdentifiers = optionValues(args, "--bundle-id");
  if (bundleIdentifiers.length === 0) {
    throw new UsageError("signing profiles requires at least one --bundle-id");
  }
  const identitySha1 = optionValue(args, "--identity-sha1");
  const identity = selectIdentity(state, identitySha1);
  const installDirs = optionValues(args, "--install-dir");
  const profileType = optionValue(args, "--profile-type");
  const namePrefix = optionValue(args, "--name-prefix");
  const client = await clientFor(io, args, dependencies);
  const result = await ensureProvisioningProfiles({
    client,
    certificateSerial: identity.serialNumber,
    bundleIdentifiers,
    installDirs: installDirs.length > 0 ? installDirs : defaultProfileInstallDirs(dependencies.homeDir),
    ...(profileType ? { profileType } : {}),
    ...(namePrefix ? { namePrefix } : {})
  });
  mkdirSync(dirname(xcconfigPath), { recursive: true });
  writeFileSync(
    xcconfigPath,
    renderSigningXcconfig({ teamId, identity, keychainPath: state.keychainPath, profiles: result.profiles })
  );
  const basePath = optionValue(args, "--export-options-base");
  const base = basePath ? await readPlistJson(dependencies.exec, basePath) : { method: "app-store-connect" };
  await writePlist(dependencies.exec, exportOptionsPath, buildExportOptions({ base, teamId, identity, profiles: result.profiles }));
  if (json) {
    io.stdout(`${JSON.stringify({ ok: true, ...result, xcconfigPath, exportOptionsPath }, null, 2)}\n`);
  } else {
    io.stdout(`Signing certificate: ${describeCertificate(result.certificate)}\n`);
    result.profiles.forEach((profile) =>
      io.stdout(
        `profile ${profile.created ? "created" : "reused"}: ${JSON.stringify(profile.name)} bundle=${profile.bundleIdentifier} uuid=${profile.uuid} expires=${profile.expirationDate}\n`
      )
    );
    result.deletedProfileIds.forEach((id) => io.stdout(`deleted stale kit profile: ${id}\n`));
    io.stdout(`Wrote ${xcconfigPath} and ${exportOptionsPath}; xcodebuild needs no -allowProvisioningUpdates.\n`);
  }
  return 0;
}

async function deleteKeychainCommand(io: SigningCliIo, json: boolean, args: string[], dependencies: SigningCliDependencies) {
  const keychainPath = required(args, "--keychain");
  await deleteSigningKeychain({ exec: dependencies.exec, keychainPath });
  io.stdout(json ? `${JSON.stringify({ ok: true, keychainPath }, null, 2)}\n` : `Deleted keychain ${keychainPath}\n`);
  return 0;
}

async function revokeCommand(io: SigningCliIo, json: boolean, args: string[], dependencies: SigningCliDependencies) {
  const client = await clientFor(io, args, dependencies);
  const result = await revokeApiDevelopmentCertificates({ client, dryRun: args.includes("--dry-run") });
  io.stdout(json ? `${JSON.stringify({ ok: true, ...result }, null, 2)}\n` : `${result.lines.join("\n")}\n`);
  return 0;
}

async function clientFor(io: SigningCliIo, args: string[], dependencies: SigningCliDependencies): Promise<AppStoreConnectClient> {
  const configPath = optionValue(args, "--config") ?? discoverConfigPath({ env: dependencies.env });
  const retriesValue = optionValue(args, "--retries") ?? "4";
  const attempts = Number(retriesValue);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new UsageError(`--retries must be an integer from 1 to 10, got: ${retriesValue}`);
  }
  const retry: RetryOptions = {
    attempts,
    ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
    onRetry: (event) =>
      io.stderr(
        `App Store Connect ${event.method} ${event.path} failed (${event.reason}); retry ${event.attempt}/${attempts - 1} in ${event.delayMs}ms\n`
      )
  };
  return (dependencies.createClient ?? defaultClient)(configPath, retry);
}

async function defaultClient(configPath: string, retry: RetryOptions): Promise<AppStoreConnectClient> {
  return createAppStoreConnectClient({ auth: await loadAscAuth(configPath), retry });
}

class UsageError extends Error {}

function required(args: string[], name: string): string {
  const value = optionValue(args, name);
  if (!value) {
    throw new UsageError(`signing ${args[1]} requires ${name}`);
  }
  return value;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function optionValues(args: string[], name: string): string[] {
  return args.flatMap((value, index) => (value === name && args[index + 1] ? [args[index + 1]!] : []));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fail(io: SigningCliIo, json: boolean, exitCode: number, code: string, message: string): number {
  if (json) {
    io.stdout(`${JSON.stringify({ ok: false, error: { code, message } }, null, 2)}\n`);
  } else {
    io.stderr(`${message}\n`);
  }
  return exitCode;
}

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverConfigPath } from "./config.js";
import { loadManifest } from "./manifest.js";
import { createPlan, type PlanMode } from "./plan.js";
import { planStoreSubmission } from "./store.js";
import { smokeAppStoreConnect } from "./asc.js";
import { redactSecrets } from "./redaction.js";
import {
  buildXcodeCommand,
  executeRawCommand,
  runXcodeCommand,
  type RawCommandResult,
  type RunMode,
  type XcodeCommandInput,
  type XcodeCommandKind
} from "./xcode-runner.js";

export interface CliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export type Cli = (argv: string[]) => Promise<number>;

export interface CliDependencies {
  smokeAppStoreConnect?: typeof smokeAppStoreConnect;
  executeXcodeCommand?: (argv: string[]) => Promise<RawCommandResult>;
}

interface CliError {
  code: string;
  message: string;
}

const usage = `apple-distribution-kit

Usage:
  apple-distribution-kit --help
  apple-distribution-kit --version
  apple-distribution-kit manifest validate [--manifest <path>] [--json]
  apple-distribution-kit plan [--manifest <path>] [--mode dry-run|apply] [--json]
  apple-distribution-kit store review-plan --channel <id> [--manifest <path>] [--artifact <path>] [--json]
  apple-distribution-kit xcode run --kind <kind> --mode dry-run|apply [--json] [command options]
  apple-distribution-kit asc smoke [--config <path>] [--json]

Commands:
  manifest validate   Validate distribution/apple-distribution.json
  plan                Build a machine-readable distribution plan
  store review-plan   Build App Store review-prep actions/blockers
  xcode run           Build or run Apple toolchain commands behind an explicit mode gate
  asc smoke           Verify App Store Connect API credentials without printing secrets
`;

export function createCli(io: CliIo, dependencies: CliDependencies = {}): Cli {
  const smoke = dependencies.smokeAppStoreConnect ?? smokeAppStoreConnect;
  return async (argv: string[]) => {
    const args = [...argv];
    const json = takeFlag(args, "--json");

    if (takeFlag(args, "--help") || args.length === 0) {
      io.stdout(usage);
      return 0;
    }

    if (takeFlag(args, "--version")) {
      io.stdout(`${packageVersion()}\n`);
      return 0;
    }

    const command = args[0];
    const subcommand = args[1];
    if (command === "manifest" && subcommand === "validate") {
      return validateManifestCommand(io, json, args);
    }
    if (command === "plan") {
      return planCommand(io, json, args);
    }
    if (command === "store" && subcommand === "review-plan") {
      return storeReviewPlanCommand(io, json, args);
    }
    if (command === "xcode" && subcommand === "run") {
      return xcodeRunCommand(io, json, args, dependencies.executeXcodeCommand ?? executeRawCommand);
    }
    if (command === "asc" && subcommand === "smoke") {
      return ascSmokeCommand(io, json, args, smoke);
    }

    return fail(io, json, 64, {
      code: "unknown_command",
      message: `Unknown command: ${command}`
    });
  };
}

async function ascSmokeCommand(
  io: CliIo,
  json: boolean,
  args: string[],
  smoke: typeof smokeAppStoreConnect
): Promise<number> {
  const configPath = optionValue(args, "--config") ?? discoverConfigPath({ env: process.env });
  try {
    const result = await smoke({ configPath });
    if (json) {
      io.stdout(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
    } else {
      io.stdout("App Store Connect API smoke passed\n");
    }
    return 0;
  } catch (error) {
    return fail(io, json, 69, {
      code: "asc_smoke_failed",
      message: (error as Error).message
    });
  }
}

async function planCommand(io: CliIo, json: boolean, args: string[]): Promise<number> {
  const modeValue = optionValue(args, "--mode") ?? "dry-run";
  if (!isPlanMode(modeValue)) {
    return fail(io, json, 64, {
      code: "invalid_mode",
      message: `Unknown plan mode: ${modeValue}`
    });
  }

  const manifestPath = optionValue(args, "--manifest") ?? "distribution/apple-distribution.json";
  try {
    const manifest = await loadManifest(manifestPath);
    const plan = createPlan({ manifest, mode: modeValue });
    if (json) {
      io.stdout(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      io.stdout(
        `Distribution plan: ${plan.app.name} (${plan.actions.length} ${pluralize("action", plan.actions.length)}, mode ${plan.mode})\n`
      );
    }
    return 0;
  } catch (error) {
    return fail(io, json, 65, {
      code: "plan_failed",
      message: (error as Error).message
    });
  }
}

async function storeReviewPlanCommand(io: CliIo, json: boolean, args: string[]): Promise<number> {
  const channelId = optionValue(args, "--channel");
  if (!channelId) {
    return fail(io, json, 64, {
      code: "missing_channel",
      message: "store review-plan requires --channel <id>"
    });
  }

  const manifestPath = optionValue(args, "--manifest") ?? "distribution/apple-distribution.json";
  try {
    const manifest = await loadManifest(manifestPath);
    const plan = planStoreSubmission({ manifest, channelId, assetRoot: dirname(manifestPath) });
    const artifactPath = optionValue(args, "--artifact");
    const body = `${JSON.stringify(plan, null, 2)}\n`;
    if (artifactPath) {
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, body);
    }
    if (json) {
      io.stdout(body);
    } else {
      io.stdout(
        `Store review plan: ${plan.actions.length} ${pluralize("action", plan.actions.length)}, ${plan.blockers.length} ${pluralize("blocker", plan.blockers.length)}\n`
      );
    }
    return 0;
  } catch (error) {
    return fail(io, json, 65, {
      code: "store_review_plan_failed",
      message: (error as Error).message
    });
  }
}

async function xcodeRunCommand(
  io: CliIo,
  json: boolean,
  args: string[],
  execute: (argv: string[]) => Promise<RawCommandResult>
): Promise<number> {
  const modeValue = optionValue(args, "--mode") ?? "dry-run";
  if (!isRunMode(modeValue)) {
    return fail(io, json, 64, {
      code: "invalid_mode",
      message: `Unknown xcode run mode: ${modeValue}`
    });
  }

  const kindValue = optionValue(args, "--kind");
  if (!kindValue || !isXcodeCommandKind(kindValue)) {
    return fail(io, json, 64, {
      code: "invalid_kind",
      message: "xcode run requires --kind codesign|productbuild|notary-submit|stapler|stapler-validate|spctl|altool-validate|altool-upload"
    });
  }

  const commandInput = xcodeCommandInput(kindValue, args);
  if ("error" in commandInput) {
    return fail(io, json, 64, {
      code: "missing_option",
      message: commandInput.error
    });
  }

  try {
    const command = buildXcodeCommand(commandInput);
    const result = await runXcodeCommand({ command, mode: modeValue, execute });
    const redactedResult = redactXcodeRunResult(result);
    if (json) {
      io.stdout(`${JSON.stringify(redactedResult, null, 2)}\n`);
    } else if (result.mode === "dry-run") {
      io.stdout(`Would run: ${redactedResult.command.join(" ")}\n`);
    } else if (result.ok) {
      io.stdout(`Command passed: ${kindValue}\n`);
    } else {
      io.stderr(`Command failed: ${kindValue} exited ${result.exitCode}\n`);
    }
    return result.ok ? 0 : result.exitCode;
  } catch (error) {
    return fail(io, json, 69, {
      code: "xcode_run_failed",
      message: (error as Error).message
    });
  }
}

function redactXcodeRunResult(result: Awaited<ReturnType<typeof runXcodeCommand>>): Awaited<ReturnType<typeof runXcodeCommand>> {
  const command = redactCommand(result.command);
  if (result.mode === "dry-run") {
    return { ...result, command };
  }
  return {
    ...result,
    command,
    stdout: redactCommandText(result.stdout, result.command),
    stderr: redactCommandText(result.stderr, result.command)
  };
}

function redactCommand(argv: string[]): string[] {
  const valueFlags = new Set(["--password", "-p", "--p8-file-path", "--auth-string"]);
  return argv.map((value, index) => {
    const previous = argv[index - 1];
    if (previous && valueFlags.has(previous)) {
      return "[REDACTED_SECRET]";
    }
    return value;
  });
}

function redactCommandText(text: string, argv: string[]): string {
  const valueFlags = new Set(["--password", "-p", "--p8-file-path", "--auth-string"]);
  const secretValues = argv.filter((value, index) => {
    const previous = argv[index - 1];
    return Boolean(previous && valueFlags.has(previous) && value);
  });
  const commandRedacted = secretValues.reduce((redacted, value) => redacted.split(value).join("[REDACTED_SECRET]"), text);
  return redactSecrets(commandRedacted) as string;
}

async function validateManifestCommand(io: CliIo, json: boolean, args: string[]): Promise<number> {
  const manifestPath = optionValue(args, "--manifest") ?? "distribution/apple-distribution.json";
  try {
    await loadManifest(manifestPath);
    if (json) {
      io.stdout(`${JSON.stringify({ ok: true, manifestPath }, null, 2)}\n`);
    } else {
      io.stdout(`Manifest valid: ${manifestPath}\n`);
    }
    return 0;
  } catch (error) {
    return fail(io, json, 65, {
      code: "manifest_invalid",
      message: (error as Error).message
    });
  }
}

function isPlanMode(value: string): value is PlanMode {
  return value === "dry-run" || value === "apply";
}

function isRunMode(value: string): value is RunMode {
  return value === "dry-run" || value === "apply";
}

function isXcodeCommandKind(value: string): value is XcodeCommandKind {
  return [
    "codesign",
    "productbuild",
    "notary-submit",
    "stapler",
    "stapler-validate",
    "spctl",
    "altool-validate",
    "altool-upload"
  ].includes(value);
}

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

function fail(io: CliIo, json: boolean, exitCode: number, error: CliError): number {
  if (json) {
    io.stdout(`${JSON.stringify({ ok: false, error }, null, 2)}\n`);
  } else {
    io.stderr(`${error.message}\n`);
  }
  return exitCode;
}

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(here, "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
  return packageJson.version;
}

function xcodeCommandInput(kind: XcodeCommandKind, args: string[]): XcodeCommandInput | { error: string } {
  switch (kind) {
    case "codesign":
      return requireOptions(args, ["--identity", "--path", "--entitlements"], (values) => ({
        kind,
        identity: values["--identity"]!,
        path: values["--path"]!,
        entitlements: values["--entitlements"]!
      }));
    case "productbuild":
      return requireOptions(args, ["--identity", "--component", "--install-location", "--output"], (values) => ({
        kind,
        identity: values["--identity"]!,
        component: values["--component"]!,
        installLocation: values["--install-location"]!,
        output: values["--output"]!
      }));
    case "notary-submit":
      return requireOptions(args, ["--apple-id", "--team-id", "--password-keychain-item", "--package-path"], (values) => ({
        kind,
        appleId: values["--apple-id"]!,
        teamId: values["--team-id"]!,
        passwordKeychainItem: values["--password-keychain-item"]!,
        packagePath: values["--package-path"]!
      }));
    case "stapler":
    case "stapler-validate":
    case "spctl":
      return requireOptions(args, ["--path"], (values) => ({ kind, path: values["--path"]! }) as XcodeCommandInput);
    case "altool-validate":
    case "altool-upload":
      return xcodeAltoolInput(kind, args);
  }
}

function xcodeAltoolInput(kind: "altool-validate" | "altool-upload", args: string[]): XcodeCommandInput | { error: string } {
  const packagePath = optionValue(args, "--package-path");
  if (!packagePath) {
    return { error: "xcode run requires --package-path for altool commands" };
  }
  const providerPublicId = optionValue(args, "--provider-public-id");
  const apiKey = optionValue(args, "--api-key");
  const apiIssuer = optionValue(args, "--api-issuer");
  if (apiKey || apiIssuer) {
    if (!apiKey || !apiIssuer) {
      return { error: "xcode run altool API auth requires both --api-key and --api-issuer" };
    }
    return {
      kind,
      packagePath,
      apiKey,
      apiIssuer,
      ...(optionValue(args, "--p8-file-path") ? { p8FilePath: optionValue(args, "--p8-file-path")! } : {}),
      ...(providerPublicId ? { providerPublicId } : {})
    } as XcodeCommandInput;
  }

  const username = optionValue(args, "--username");
  const password = optionValue(args, "--password");
  if (!username || !password) {
    return { error: "xcode run altool commands require API key auth or --username and --password" };
  }
  return {
    kind,
    packagePath,
    username,
    password,
    ...(providerPublicId ? { providerPublicId } : {})
  } as XcodeCommandInput;
}

function requireOptions<T>(
  args: string[],
  names: string[],
  build: (values: Record<string, string>) => T
): T | { error: string } {
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = optionValue(args, name);
    if (!value) {
      return { error: `xcode run requires ${name}` };
    }
    values[name] = value;
  }
  return build(values);
}

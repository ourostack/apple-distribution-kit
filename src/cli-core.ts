import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverConfigPath } from "./config.js";
import { loadManifest } from "./manifest.js";
import { createPlan, type PlanMode } from "./plan.js";
import { planStoreSubmission } from "./store.js";
import { smokeAppStoreConnect } from "./asc.js";

export interface CliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export type Cli = (argv: string[]) => Promise<number>;

export interface CliDependencies {
  smokeAppStoreConnect?: typeof smokeAppStoreConnect;
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
  apple-distribution-kit asc smoke [--config <path>] [--json]

Commands:
  manifest validate   Validate distribution/apple-distribution.json
  plan                Build a machine-readable distribution plan
  store review-plan   Build App Store review-prep actions/blockers
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
    const plan = planStoreSubmission({ manifest, channelId });
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

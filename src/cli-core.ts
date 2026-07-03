import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "./manifest.js";

export interface CliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export type Cli = (argv: string[]) => Promise<number>;

interface CliError {
  code: string;
  message: string;
}

const usage = `apple-distribution-kit

Usage:
  apple-distribution-kit --help
  apple-distribution-kit --version
  apple-distribution-kit manifest validate [--manifest <path>] [--json]
  apple-distribution-kit asc smoke [--config <path>] [--json]

Commands:
  manifest validate   Validate distribution/apple-distribution.json
  asc smoke           Verify App Store Connect API credentials without printing secrets
`;

export function createCli(io: CliIo): Cli {
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
    if (command === "asc" && subcommand === "smoke") {
      return notImplemented(io, json, "asc_smoke_not_implemented", "asc smoke is not implemented yet");
    }

    return fail(io, json, 64, {
      code: "unknown_command",
      message: `Unknown command: ${command}`
    });
  };
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

function notImplemented(io: CliIo, json: boolean, code: string, message: string): number {
  return fail(io, json, 70, { code, message });
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

import { spawn } from "node:child_process";

export type XcodeCommandKind =
  | "codesign"
  | "productbuild"
  | "notary-submit"
  | "stapler"
  | "stapler-validate"
  | "spctl"
  | "altool-validate"
  | "altool-upload";

export interface XcodeCommand {
  kind: XcodeCommandKind;
  argv: string[];
}

export type XcodeCommandInput =
  | { kind: "codesign"; identity: string; path: string; entitlements: string }
  | { kind: "productbuild"; identity: string; component: string; installLocation: string; output: string }
  | { kind: "notary-submit"; appleId: string; teamId: string; passwordKeychainItem: string; packagePath: string }
  | { kind: "stapler"; path: string }
  | { kind: "stapler-validate"; path: string }
  | { kind: "spctl"; path: string }
  | ({ kind: "altool-validate"; packagePath: string } & AltoolAuthInput)
  | ({ kind: "altool-upload"; packagePath: string } & AltoolAuthInput);

export type AltoolAuthInput =
  | { apiKey: string; apiIssuer: string; p8FilePath?: string; providerPublicId?: string }
  | { username: string; password: string; providerPublicId?: string };

export interface RawCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RunMode = "dry-run" | "apply";

export type XcodeRunResult =
  | { ok: true; mode: "dry-run"; command: string[] }
  | ({ ok: true; mode: "apply"; command: string[] } & RawCommandResult)
  | ({ ok: false; mode: "apply"; command: string[] } & RawCommandResult);

export class XcodeRunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "XcodeRunnerError";
    this.code = code;
  }
}

export function buildXcodeCommand(input: XcodeCommandInput): XcodeCommand {
  switch (input.kind) {
    case "codesign":
      return {
        kind: input.kind,
        argv: [
          "codesign",
          "--force",
          "--deep",
          "--options",
          "runtime",
          "--timestamp",
          "--entitlements",
          input.entitlements,
          "--sign",
          input.identity,
          input.path
        ]
      };
    case "productbuild":
      return {
        kind: input.kind,
        argv: ["productbuild", "--component", input.component, input.installLocation, "--sign", input.identity, input.output]
      };
    case "notary-submit":
      return {
        kind: input.kind,
        argv: [
          "xcrun",
          "notarytool",
          "submit",
          input.packagePath,
          "--apple-id",
          input.appleId,
          "--team-id",
          input.teamId,
          "--keychain-profile",
          input.passwordKeychainItem,
          "--wait"
        ]
      };
    case "stapler":
      return { kind: input.kind, argv: ["xcrun", "stapler", "staple", input.path] };
    case "stapler-validate":
      return { kind: input.kind, argv: ["xcrun", "stapler", "validate", input.path] };
    case "spctl":
      return { kind: input.kind, argv: ["spctl", "--assess", "--type", "execute", input.path] };
    case "altool-validate":
      return {
        kind: input.kind,
        argv: [
          "xcrun",
          "altool",
          "--validate-app",
          "-f",
          input.packagePath,
          "--type",
          "macos",
          ...buildAltoolAuthArgs(input),
          "--output-format",
          "json"
        ]
      };
    case "altool-upload":
      return {
        kind: input.kind,
        argv: [
          "xcrun",
          "altool",
          "--upload-package",
          input.packagePath,
          "--type",
          "macos",
          ...buildAltoolAuthArgs(input),
          "--output-format",
          "json",
          "--wait"
        ]
      };
  }
}

export async function runXcodeCommand(input: {
  command: XcodeCommand;
  mode: RunMode;
  execute?: (argv: string[]) => Promise<RawCommandResult>;
}): Promise<XcodeRunResult> {
  if (input.mode === "dry-run") {
    return { ok: true, mode: "dry-run", command: input.command.argv };
  }
  const execute = input.execute ?? missingExecutor;
  const result = await execute(input.command.argv);
  return { ok: result.exitCode === 0, mode: "apply", command: input.command.argv, ...result };
}

export function parseXcodeResult(input: XcodeCommand & RawCommandResult):
  | { ok: true; status: "accepted" | "ok" }
  | { ok: false; status: "invalid" | "failed"; message: string } {
  if (input.kind === "notary-submit" && input.exitCode === 0 && /status:\s*Accepted/i.test(input.stdout)) {
    return { ok: true, status: "accepted" };
  }
  if (input.kind === "notary-submit") {
    return { ok: false, status: "invalid", message: input.stderr };
  }
  return input.exitCode === 0 ? { ok: true, status: "ok" } : { ok: false, status: "failed", message: input.stderr };
}

export async function executeRawCommand(argv: string[]): Promise<RawCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

async function missingExecutor(): Promise<RawCommandResult> {
  throw new XcodeRunnerError("missing_executor", "No command executor was provided for apply mode.");
}

function buildAltoolAuthArgs(input: AltoolAuthInput): string[] {
  const args =
    "apiKey" in input
      ? ["--api-key", input.apiKey, "--api-issuer", input.apiIssuer]
      : ["--username", input.username, "--password", input.password];

  if ("p8FilePath" in input && input.p8FilePath) {
    args.push("--p8-file-path", input.p8FilePath);
  }
  if (input.providerPublicId) {
    args.push("--provider-public-id", input.providerPublicId);
  }
  return args;
}

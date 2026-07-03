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
  | { kind: "altool-validate"; packagePath: string; apiKey: string; apiIssuer: string; providerPublicId: string }
  | { kind: "altool-upload"; packagePath: string; apiKey: string; apiIssuer: string; providerPublicId: string };

export interface RawCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RunMode = "dry-run" | "apply";

export type XcodeRunResult =
  | { ok: true; mode: "dry-run"; command: string[] }
  | ({ ok: true; mode: "apply"; command: string[] } & RawCommandResult);

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
          "--options",
          "runtime",
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
          "--api-key",
          input.apiKey,
          "--api-issuer",
          input.apiIssuer,
          "--asc-provider",
          input.providerPublicId
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
          "--api-key",
          input.apiKey,
          "--api-issuer",
          input.apiIssuer,
          "--asc-provider",
          input.providerPublicId,
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
  return { ok: true, mode: "apply", command: input.command.argv, ...result };
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

async function missingExecutor(): Promise<RawCommandResult> {
  throw new XcodeRunnerError("missing_executor", "No command executor was provided for apply mode.");
}

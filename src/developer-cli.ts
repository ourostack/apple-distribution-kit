import { readFileSync } from "node:fs";
import { createDeveloperClient } from "./developer.js";
import { DeveloperError, importDeveloperSession, loadDeveloperSession, readDeveloperPrivateInput, validateDeveloperId } from "./developer-session.js";
import type { CliIo } from "./cli-core.js";

export interface DeveloperCliDependencies {
  fetch?: typeof globalThis.fetch;
  readStdin?: () => string;
}
export const developerUsage = `  apple-distribution-kit developer session import --team-id <id> --session-file <private-path> [--input <private-input-path>|-] [--json]
  apple-distribution-kit developer status --team-id <id> --session-file <private-path> [--json]
  apple-distribution-kit developer keys list --team-id <id> --session-file <private-path> [--json]
  apple-distribution-kit developer keys get --key-id <id> --team-id <id> --session-file <private-path> [--json]
`;

function parse(args: string[]): { command: string; options: Map<string, string>; json: boolean } {
  let count = 2;
  let command = args[1] ?? "";
  if (command === "session" || command === "keys") { command += ` ${args[2] ?? ""}`; count = 3; }
  if (!["status", "session import", "keys list", "keys get"].includes(command)) throw new DeveloperError("invalid_arguments");
  const allowed = new Set(["--team-id", "--session-file", "--json", ...(command === "session import" ? ["--input"] : []), ...(command === "keys get" ? ["--key-id"] : [])]);
  const options = new Map<string, string>();
  for (let i = count; i < args.length; i++) {
    const option = args[i]!;
    if (!allowed.has(option) || options.has(option)) throw new DeveloperError("invalid_arguments");
    if (option === "--json") { options.set(option, "true"); continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new DeveloperError("invalid_arguments");
    options.set(option, value);
  }
  validateDeveloperId(options.get("--team-id"));
  if (!options.get("--session-file")) throw new DeveloperError("invalid_arguments");
  if (command === "keys get") validateDeveloperId(options.get("--key-id"));
  return { command, options, json: options.has("--json") };
}

export async function developerCommand(io: CliIo, args: string[], dependencies: DeveloperCliDependencies = {}): Promise<number> {
  const json = args.includes("--json");
  try {
    const { command, options } = parse(args);
    const teamId = options.get("--team-id")!;
    const sessionFile = options.get("--session-file")!;
    let result: unknown;
    if (command === "session import") {
      const inputPath = options.get("--input");
      let input: unknown;
      if (inputPath && inputPath !== "-") input = readDeveloperPrivateInput(inputPath);
      else {
        try {
          const source = (dependencies.readStdin ?? (() => readFileSync(0, "utf8")))();
          if (Buffer.byteLength(source) > 1024 * 1024) throw new DeveloperError("invalid_session");
          input = JSON.parse(source) as unknown;
        } catch { throw new DeveloperError("invalid_session"); }
      }
      importDeveloperSession({ teamId, sessionFile, input });
      result = { enrolled: true, teamId };
    } else {
      const session = loadDeveloperSession({ teamId, sessionFile });
      const client = createDeveloperClient({ teamId, session, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) });
      result = command === "status" ? await client.status() : command === "keys list" ? await client.keys.list() : await client.keys.get(options.get("--key-id")!);
    }
    io.stdout(`${JSON.stringify(json ? { ok: true, result } : result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const safe = error instanceof DeveloperError ? error : new DeveloperError("invalid_session");
    const envelope = { code: safe.code, message: safe.message, ...(safe.requiresHuman ? { requiresHuman: safe.requiresHuman } : {}) };
    if (json) io.stdout(`${JSON.stringify({ ok: false, error: envelope }, null, 2)}\n`);
    else io.stderr(`${JSON.stringify(envelope)}\n`);
    return safe.code === "invalid_arguments" ? 64 : 69;
  }
}

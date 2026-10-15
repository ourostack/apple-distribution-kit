import { readFileSync } from "node:fs";
import { createDeveloperClient } from "./developer.js";
import { assertDeveloperPlatform, DeveloperError, importDeveloperSession, loadDeveloperSession, readDeveloperPrivateInput, validateDeveloperId } from "./developer-session.js";
import type { CliIo } from "./cli-core.js";
import { planDeveloperKey, applyDeveloperKey, reconcileDeveloperKey, type DeveloperKeyPlanOptions } from "./developer-keys.js";
import { getDeveloperService, planDeveloperService, applyDeveloperService, reconcileDeveloperService,
  type DeveloperServiceConfiguration } from "./developer-services.js";
import { developerRecord } from "./developer-transport.js";

export interface DeveloperCliDependencies {
  fetch?: typeof globalThis.fetch;
  readStdin?: () => string;
}
export const developerUsage = `  apple-distribution-kit developer session import --team-id <id> --session-file <private-path> [--input <private-input-path>|-] [--json]
  apple-distribution-kit developer status --team-id <id> --session-file <private-path> [--json]
  apple-distribution-kit developer keys list --team-id <id> --session-file <private-path> [--json]
  apple-distribution-kit developer keys get --key-id <id> --team-id <id> --session-file <private-path> [--json]
  apple-distribution-kit developer keys plan --action create|revoke|download --team-id <id> --environment <label> --primary-app-id <id> --primary-app-identifier <identifier> --session-file <private-path> --plan-file <private-path> [--key-name <name>|--key-id <id>] [--output <private-path>] [--json]
  apple-distribution-kit developer keys apply|reconcile --team-id <id> --environment <label> --session-file <private-path> --plan-file <private-path> [--json]
  apple-distribution-kit developer services get --team-id <id> --session-file <private-path> --service-id <id> --identifier <expected-client-id> [--json]
  apple-distribution-kit developer services plan --team-id <id> --environment <label> --session-file <private-path> --plan-file <private-path> --config <private-desired-json> [--json]
  apple-distribution-kit developer services apply|reconcile --team-id <id> --environment <label> --session-file <private-path> --plan-file <private-path> [--json]
`;

function parse(args: string[]): { command: string; options: Map<string, string>; json: boolean } {
  let count = 2;
  let command = args[1] ?? "";
  if (command === "session" || command === "keys" || command === "services") { command += ` ${args[2] ?? ""}`; count = 3; }
  if (!["status", "session import", "keys list", "keys get", "keys plan", "keys apply", "keys reconcile",
    "services get", "services plan", "services apply", "services reconcile"].includes(command)) throw new DeveloperError("invalid_arguments");
  const lifecycle = ["keys plan", "keys apply", "keys reconcile", "services plan", "services apply", "services reconcile"].includes(command);
  const allowed = new Set(["--team-id", "--session-file", "--json",
    ...(command === "session import" ? ["--input"] : []), ...(command === "keys get" ? ["--key-id"] : []),
    ...(lifecycle ? ["--environment", "--plan-file"] : []),
    ...(command === "services get" ? ["--service-id", "--identifier"] : []),
    ...(command === "services plan" ? ["--config"] : []),
    ...(command === "keys plan" ? ["--action", "--primary-app-id", "--primary-app-identifier", "--key-name", "--key-id", "--output"] : [])]);
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
  if (command === "services get") {
    validateDeveloperId(options.get("--service-id"));
    if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(options.get("--identifier") ?? "")) throw new DeveloperError("invalid_arguments");
  }
  if (command === "services plan" && !options.get("--config")) throw new DeveloperError("invalid_arguments");
  if (lifecycle) {
    if (!options.get("--plan-file") || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(options.get("--environment") ?? "")) throw new DeveloperError("invalid_arguments");
    if (command === "keys plan") {
      validateDeveloperId(options.get("--primary-app-id"));
      const identifier = options.get("--primary-app-identifier");
      if (!identifier || identifier.length > 255 || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(identifier)) throw new DeveloperError("invalid_arguments");
      const action = options.get("--action");
      if (!["create", "revoke", "download"].includes(action ?? "")) throw new DeveloperError("invalid_arguments");
      if (action === "create") {
        if (!options.get("--key-name") || options.has("--key-id") || options.has("--output")) throw new DeveloperError("invalid_arguments");
      } else {
        validateDeveloperId(options.get("--key-id"));
        if (options.has("--key-name") || (action === "revoke" && options.has("--output")) ||
          (action === "download" && !options.get("--output"))) throw new DeveloperError("invalid_arguments");
      }
    }
  }
  return { command, options, json: options.has("--json") };
}

export async function developerCommand(io: CliIo, args: string[], dependencies: DeveloperCliDependencies = {}): Promise<number> {
  const json = args.includes("--json");
  try {
    const { command, options } = parse(args);
    assertDeveloperPlatform();
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
    } else if (command.startsWith("services ")) {
      const injected = dependencies.fetch ? { fetch: dependencies.fetch } : {};
      if (command === "services get") {
        result = await getDeveloperService({ teamId, sessionFile, serviceId: options.get("--service-id")!,
          identifier: options.get("--identifier")!, ...injected });
      } else {
        const scope = { teamId, sessionFile, environment: options.get("--environment")!, planFile: options.get("--plan-file")!, ...injected };
        if (command === "services plan") {
          const config = readDeveloperPrivateInput(options.get("--config")!);
          if (!developerRecord(config) || Object.keys(config).some(k => !["serviceId", "identifier", "primaryAppId",
            "primaryAppIdentifier", "domains", "returnUrls"].includes(k))) throw new DeveloperError("invalid_arguments");
          result = await planDeveloperService({ ...config as unknown as DeveloperServiceConfiguration, ...scope });
        } else result = await (command === "services apply" ? applyDeveloperService : reconcileDeveloperService)(scope);
      }
    } else if (["keys plan", "keys apply", "keys reconcile"].includes(command)) {
      const scope = { teamId, sessionFile, environment: options.get("--environment")!, planFile: options.get("--plan-file")!,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) };
      if (command === "keys plan") {
        const action = options.get("--action")!;
        const input: DeveloperKeyPlanOptions = { ...scope, primaryAppId: options.get("--primary-app-id")!,
          primaryAppIdentifier: options.get("--primary-app-identifier")!,
          ...(action === "create" ? { action, keyName: options.get("--key-name")! } :
            action === "revoke" ? { action, keyId: options.get("--key-id")! } :
              { action: "download", keyId: options.get("--key-id")!, output: options.get("--output")! }) };
        result = await planDeveloperKey(input);
      } else result = await (command === "keys apply" ? applyDeveloperKey : reconcileDeveloperKey)(scope);
    } else {
      const session = loadDeveloperSession({ teamId, sessionFile });
      const client = createDeveloperClient({ teamId, session, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) });
      result = command === "status" ? await client.status() : command === "keys list" ? await client.keys.list() : await client.keys.get(options.get("--key-id")!);
    }
    const uncertain = typeof result === "object" && result !== null && "state" in result && result.state === "uncertain";
    io.stdout(`${JSON.stringify(json ? { ok: !uncertain, result } : result, null, 2)}\n`);
    return uncertain ? 69 : 0;
  } catch (error) {
    const safe = error instanceof DeveloperError ? error : new DeveloperError("invalid_session");
    const envelope = { code: safe.code, message: safe.message, ...(safe.requiresHuman ? { requiresHuman: safe.requiresHuman } : {}) };
    if (json) io.stdout(`${JSON.stringify({ ok: false, error: envelope }, null, 2)}\n`);
    else io.stderr(`${JSON.stringify(envelope)}\n`);
    return safe.code === "invalid_arguments" ? 64 : 69;
  }
}

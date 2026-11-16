import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverConfigPath } from "./config.js";
import { loadManifest } from "./manifest.js";
import { createPlan, type PlanMode } from "./plan.js";
import { planStoreSubmission } from "./store.js";
import { ascBaseUrl, getAppStoreConnect, smokeAppStoreConnect } from "./asc.js";
import { readReviewStatusFromConfig, REVIEW_PLATFORMS, reviewTransition, type ReviewPlatform } from "./review.js";
import { redactSecrets } from "./redaction.js";
import { checkLoginServices, collectLoginServiceSources } from "./login-services.js";
import { signingCommand, type SigningCliDependencies } from "./signing-cli.js";
import { developerCommand, type DeveloperCliDependencies } from "./developer-cli.js";
import { EXIT } from "./exit-codes.js";
import { cli as axCli } from "./command-table.js";
import { runCli } from "./ouro-ax/cli.ts";
import { parse } from "./ouro-ax/command.ts";
import { errorJson, errorLine, isAxError } from "./ouro-ax/problem.ts";
import { DRY_RUN_FLAG } from "./ouro-ax/effects.ts";
import { buildTestFlightRequests, planTestFlightSubmission, publishTestFlightRequests } from "./testflight.js";
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
  getAppStoreConnect?: typeof getAppStoreConnect;
  readReviewStatus?: typeof readReviewStatusFromConfig;
  executeXcodeCommand?: (argv: string[]) => Promise<RawCommandResult>;
  publishTestFlightRequests?: typeof publishTestFlightRequests;
  signing?: Partial<SigningCliDependencies>;
  developer?: DeveloperCliDependencies;
}

interface CliError {
  code: string;
  message: string;
  details?: unknown;
}

function runAxCli(io: CliIo, argv: string[]): Promise<number> {
  return runCli(axCli, argv, { stdout: { write: (chunk) => io.stdout(String(chunk)) }, stderr: { write: (chunk) => io.stderr(String(chunk)) } });
}

/** Identifiers a developer command other people see takes, with what each is and where to take a right one. */
const REFERENCES: readonly { flag: string; pattern: RegExp; what: string; where: string }[] = [
  { flag: "team-id", pattern: /^[A-Z0-9]{10}$/, what: "a 10-character team id", where: "your team's id on developer.apple.com, under Membership" },
  { flag: "key-id", pattern: /^[A-Z0-9]{10}$/, what: "a 10-character key id", where: "the key list on developer.apple.com, under Keys" },
  { flag: "identifier", pattern: /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/, what: "a bundle-style identifier, such as app.example.web", where: "the identifiers list on developer.apple.com" },
];

/** A wrong reference to a developer command other people see is refused before anything runs, and says where to get one. */
function wrongReference(io: CliIo, argv: string[], command: string): number | undefined {
  if (!command.startsWith("developer ")) return undefined;
  for (const { flag, pattern, what, where } of REFERENCES) {
    const at = argv.indexOf(`--${flag}`);
    const value = String(argv[at + 1]);
    if (at < 0 || pattern.test(value)) continue;
    const shape = { code: "bad-reference", exit: EXIT.usage, thing: command, problem: `--${flag} "${value}" is not ${what}`, fix: `take the right value from ${where}, then run it again` };
    io.stderr(`${errorLine(axCli.name, shape)}\n`);
    if (argv.includes("--json")) io.stdout(`${JSON.stringify(errorJson(shape), null, 2)}\n`);
    return EXIT.usage;
  }
  return undefined;
}

/** The kit's check of a command line before it runs: unknown flags, missing arguments, a missing --why, a bad value. */
function rejectedByKit(io: CliIo, argv: string[]): number | undefined {
  const words = argv.filter((arg) => arg !== "--json");
  if (words.length === 0 || words[0] === "help" || words.includes("--help") || words.includes("--version")) return undefined;
  try {
    const parsed = parse(axCli, argv);
    return parsed.kind === "run" && parsed.command.effect === "others" ? wrongReference(io, argv, parsed.command.name) : undefined;
  } catch (error) {
    /* istanbul ignore if @preserve -- parse throws only the kit's AxError */
    if (!isAxError(error)) throw error;
    io.stderr(`${errorLine(axCli.name, error.shape)}\n`);
    if (argv.includes("--json")) io.stdout(`${JSON.stringify(errorJson(error.shape), null, 2)}\n`);
    return error.shape.exit;
  }
}

/** Whether a `--dry-run` preview is the kit's (a command with its own `--dry-run`, such as revoke, keeps its own). */
function previewThroughKit(argv: string[]): boolean {
  if (!argv.includes("--dry-run")) return false;
  const parsed = parse(axCli, argv);
  return parsed.kind === "run" && parsed.input[DRY_RUN_FLAG] === true && parsed.command.flags?.["dry-run"] === undefined;
}

export function createCli(io: CliIo, dependencies: CliDependencies = {}): Cli {
  const smoke = dependencies.smokeAppStoreConnect ?? smokeAppStoreConnect;
  return async (argv: string[]) => {
    const rejected = rejectedByKit(io, argv);
    if (rejected !== undefined) return rejected;
    if (previewThroughKit(argv)) return runAxCli(io, argv);
    const words = argv.filter((arg) => arg !== "--json");
    if (argv.includes("--help") || words.length === 0 || words[0] === "help") {
      return runAxCli(io, words.length === 0 ? ["--help"] : argv);
    }
    const args = [...argv];
    if (args[0] === "--json" && args[1] === "developer") {
      return developerCommand(io, [...args.slice(1), "--json"], dependencies.developer);
    }
    if (args[0] === "developer") return developerCommand(io, args, dependencies.developer);
    const json = takeFlag(args, "--json");

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
    if (command === "testflight" && subcommand === "plan") {
      return testFlightPlanCommand(io, json, args);
    }
    if (command === "testflight" && subcommand === "publish") {
      return testFlightPublishCommand(io, json, args, dependencies.publishTestFlightRequests ?? publishTestFlightRequests);
    }
    if (command === "xcode" && subcommand === "run") {
      return xcodeRunCommand(io, json, args, dependencies.executeXcodeCommand ?? executeRawCommand);
    }
    if (command === "asc" && subcommand === "smoke") {
      return ascSmokeCommand(io, json, args, smoke);
    }
    if (command === "review" && subcommand === "status") {
      return reviewStatusCommand(io, json, args, dependencies.readReviewStatus ?? readReviewStatusFromConfig);
    }
    if (command === "review" && subcommand === "login-services") {
      return reviewLoginServicesCommand(io, json, args);
    }
    if (command === "asc" && subcommand === "get") {
      return ascGetCommand(io, json, args, dependencies.getAppStoreConnect ?? getAppStoreConnect);
    }

    /* istanbul ignore else @preserve -- the kit refuses an unknown command before this runs */
    if (command === "signing") {
      return signingCommand(io, json, args, {
        exec: dependencies.executeXcodeCommand ?? executeRawCommand,
        env: process.env,
        ...dependencies.signing
      });
    }

    /* istanbul ignore next @preserve -- the kit refuses an unknown command before this runs */
    return fail(io, json, EXIT.usage, {
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
    const result = await smoke({ configPath, baseUrl: ascBaseUrl(process.env) });
    if (json) {
      io.stdout(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
    } else {
      io.stdout("App Store Connect API smoke passed\n");
    }
    return 0;
  } catch (error) {
    return fail(io, json, EXIT.unavailable, {
      code: "asc_smoke_failed",
      message: (error as Error).message
    });
  }
}

async function reviewStatusCommand(
  io: CliIo,
  json: boolean,
  args: string[],
  readStatus: typeof readReviewStatusFromConfig
): Promise<number> {
  const bundleId = optionValue(args, "--bundle-id");
  /* istanbul ignore if @preserve -- the kit requires --bundle-id before this runs */
  if (!bundleId) {
    return fail(io, json, EXIT.usage, { code: "missing_bundle_id", message: "review status requires --bundle-id <id>" });
  }
  const platform = optionValue(args, "--platform");
  if (platform !== undefined && !REVIEW_PLATFORMS.includes(platform as ReviewPlatform)) {
    return fail(io, json, EXIT.usage, { code: "invalid_platform", message: `Unknown platform: ${platform}` });
  }
  try {
    const status = await readStatus({
      configPath: optionValue(args, "--config") ?? discoverConfigPath({ env: process.env }),
      bundleId,
      ...(platform ? { platforms: [platform as ReviewPlatform] } : {})
    });
    if (json) {
      io.stdout(`${JSON.stringify({ ok: true, result: status }, null, 2)}\n`);
      return 0;
    }
    for (const version of status.versions) {
      const note = reviewTransition(undefined, version.state, `${version.platform} ${version.version}`)!;
      io.stdout(`${version.platform} ${version.version}: ${version.state} (${note.kind})\n`);
    }
    for (const submission of status.submissions) {
      io.stdout(`Review submission ${submission.id} (${submission.platform}): ${submission.state}${submission.submittedDate ? `, submitted ${submission.submittedDate}` : ""}\n`);
    }
    return 0;
  } catch (error) {
    return fail(io, json, EXIT.unavailable, { code: "review_status_failed", message: (error as Error).message });
  }
}

async function reviewLoginServicesCommand(io: CliIo, json: boolean, args: string[]): Promise<number> {
  /* istanbul ignore if @preserve -- the kit refuses a --root with no value before this runs */
  if (args.includes("--root") && !optionValue(args, "--root")) {
    return fail(io, json, EXIT.usage, { code: "missing_root", message: "review login-services --root needs a directory" });
  }
  const root = optionValue(args, "--root") ?? process.cwd();
  let report;
  try {
    report = checkLoginServices(await collectLoginServiceSources(root));
  } catch (error) {
    return fail(io, json, EXIT.noInput, { code: "login_services_failed", message: (error as Error).message });
  }
  const passed = report.findings.length === 0;
  if (json) {
    io.stdout(`${JSON.stringify({ ok: passed, result: report }, null, 2)}\n`);
    return passed ? 0 : 1;
  }
  for (const finding of report.findings) {
    const where = finding.path ? ` (${finding.path}:${finding.line})` : "";
    io.stdout(`FAIL ${finding.rule}: ${finding.message}${where}\n`);
  }
  for (const note of report.notes) io.stdout(`note: ${note}\n`);
  if (report.applies) {
    const providers = [...new Set(report.thirdParty.map((hit) => hit.provider))].join(", ");
    io.stdout(
      passed
        ? `Guideline 4.8 login services: passed (${providers} login with Sign in with Apple${
            report.orderChecked ? " first" : "; button order not compared, no file holds both buttons"
          })\n`
        : `Guideline 4.8 login services: ${report.findings.length} ${pluralize("finding", report.findings.length)}\n`
    );
  }
  return passed ? 0 : 1;
}

async function ascGetCommand(
  io: CliIo,
  json: boolean,
  args: string[],
  getAsc: typeof getAppStoreConnect
): Promise<number> {
  const path = optionValue(args, "--path");
  /* istanbul ignore if @preserve -- the kit requires --path before this runs */
  if (!path) {
    return fail(io, json, EXIT.usage, {
      code: "missing_path",
      message: "asc get requires --path <path>"
    });
  }
  try {
    const baseUrl = ascBaseUrl(process.env);
    const result = await getAsc({
      configPath: optionValue(args, "--config") ?? discoverConfigPath({ env: process.env }),
      path,
      query: parseNameValueOptions(optionValues(args, "--query"), "--query"),
      baseUrl
    });
    if (json) {
      io.stdout(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
    } else {
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    return fail(io, json, EXIT.unavailable, {
      code: "asc_get_failed",
      message: (error as Error).message
    });
  }
}

async function planCommand(io: CliIo, json: boolean, args: string[]): Promise<number> {
  const modeValue = optionValue(args, "--mode") ?? "dry-run";
  /* istanbul ignore if @preserve -- the kit refuses a bad --mode before this runs */
  if (!isPlanMode(modeValue)) {
    return fail(io, json, EXIT.usage, {
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
    return fail(io, json, EXIT.invalid, {
      code: "plan_failed",
      message: (error as Error).message
    });
  }
}

async function storeReviewPlanCommand(io: CliIo, json: boolean, args: string[]): Promise<number> {
  const channelId = optionValue(args, "--channel");
  /* istanbul ignore if @preserve -- the kit requires --channel before this runs */
  if (!channelId) {
    return fail(io, json, EXIT.usage, {
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
    return fail(io, json, EXIT.invalid, {
      code: "store_review_plan_failed",
      message: (error as Error).message
    });
  }
}

async function testFlightPlanCommand(io: CliIo, json: boolean, args: string[]): Promise<number> {
  const channelId = optionValue(args, "--channel");
  /* istanbul ignore if @preserve -- the kit requires --channel before this runs */
  if (!channelId) {
    return fail(io, json, EXIT.usage, {
      code: "missing_channel",
      message: "testflight plan requires --channel <id>"
    });
  }

  const manifestPath = optionValue(args, "--manifest") ?? "distribution/apple-distribution.json";
  try {
    const manifest = await loadManifest(manifestPath);
    const plan = planTestFlightSubmission({ manifest, channelId });
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
        `TestFlight plan: ${plan.actions.length} ${pluralize("action", plan.actions.length)}, ${plan.blockers.length} ${pluralize("blocker", plan.blockers.length)}\n`
      );
    }
    return 0;
  } catch (error) {
    return fail(io, json, EXIT.invalid, {
      code: "testflight_plan_failed",
      message: (error as Error).message
    });
  }
}

async function testFlightPublishCommand(
  io: CliIo,
  json: boolean,
  args: string[],
  publish: typeof publishTestFlightRequests
): Promise<number> {
  const modeValue = optionValue(args, "--mode") ?? "dry-run";
  /* istanbul ignore if @preserve -- the kit refuses a bad --mode before this runs */
  if (!isRunMode(modeValue)) {
    return fail(io, json, EXIT.usage, {
      code: "invalid_mode",
      message: `Unknown TestFlight publish mode: ${modeValue}`
    });
  }
  const channelId = optionValue(args, "--channel");
  const appId = optionValue(args, "--app-id");
  const buildId = optionValue(args, "--build-id");
  /* istanbul ignore if @preserve -- the kit requires --channel, --app-id and --build-id before this runs */
  if (!channelId || !appId || !buildId) {
    return fail(io, json, EXIT.usage, {
      code: "missing_testflight_publish_input",
      message: "testflight publish requires --channel, --app-id, and --build-id"
    });
  }

  const manifestPath = optionValue(args, "--manifest") ?? "distribution/apple-distribution.json";
  try {
    const manifest = await loadManifest(manifestPath);
    const plan = planTestFlightSubmission({ manifest, channelId });
    if (plan.blockers.length > 0) {
      return fail(io, json, EXIT.invalid, {
        code: "testflight_publish_blocked",
        message: `testflight publish blocked: ${plan.blockers.map((blocker) => blocker.code).join(", ")}`,
        details: { blockers: plan.blockers }
      });
    }
    const requests = buildTestFlightRequests({
      manifest,
      channelId,
      appId,
      buildId,
      ...(optionValue(args, "--build-beta-detail-id")
        ? { buildBetaDetailId: optionValue(args, "--build-beta-detail-id")! }
        : {}),
      ...(optionValue(args, "--beta-app-review-detail-id")
        ? { betaAppReviewDetailId: optionValue(args, "--beta-app-review-detail-id")! }
        : {}),
      groupIdsByName: parseNameValueOptions(optionValues(args, "--group-id"), "--group-id")
    });
    const artifactPath = optionValue(args, "--artifact");
    const dryRunBody = { ok: true, mode: modeValue, requests };
    const redactedDryRunBody = redactSecrets(dryRunBody);
    if (artifactPath) {
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, `${JSON.stringify(redactedDryRunBody, null, 2)}\n`);
    }
    if (modeValue === "dry-run") {
      if (json) {
        io.stdout(`${JSON.stringify(redactedDryRunBody, null, 2)}\n`);
      } else {
        io.stdout(`TestFlight publish dry-run: ${requests.length} ${pluralize("request", requests.length)}\n`);
      }
      return 0;
    }

    const result = await publish({
      configPath: optionValue(args, "--config") ?? discoverConfigPath({ env: process.env }),
      requests
    });
    if (json) {
      io.stdout(`${JSON.stringify(redactSecrets({ ok: true, mode: modeValue, requests, result }), null, 2)}\n`);
    } else {
      io.stdout(`TestFlight publish applied: ${requests.length} ${pluralize("request", requests.length)}\n`);
    }
    return 0;
  } catch (error) {
    return fail(io, json, EXIT.invalid, {
      code: "testflight_publish_failed",
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
  /* istanbul ignore if @preserve -- the kit refuses a bad --mode before this runs */
  if (!isRunMode(modeValue)) {
    return fail(io, json, EXIT.usage, {
      code: "invalid_mode",
      message: `Unknown xcode run mode: ${modeValue}`
    });
  }

  const kindValue = optionValue(args, "--kind");
  /* istanbul ignore if @preserve -- the kit requires a known --kind before this runs */
  if (!kindValue || !isXcodeCommandKind(kindValue)) {
    return fail(io, json, EXIT.usage, {
      code: "invalid_kind",
      message: "xcode run requires --kind codesign|productbuild|notary-submit|stapler|stapler-validate|spctl|altool-validate|altool-upload"
    });
  }

  const commandInput = xcodeCommandInput(kindValue, args);
  if ("error" in commandInput) {
    return fail(io, json, EXIT.usage, {
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
    return fail(io, json, EXIT.unavailable, {
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
    return fail(io, json, EXIT.invalid, {
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

function optionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  args.forEach((value, index) => {
    if (value === name && args[index + 1]) {
      values.push(args[index + 1]!);
    }
  });
  return values;
}

function parseNameValueOptions(values: string[], label: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`Expected ${label} value to be name=id, got: ${value}`);
    }
    parsed[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return parsed;
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
    io.stdout(`${JSON.stringify({ error: { code: error.code, exit: exitCode, thing: "apple-distribution-kit", problem: error.message, fix: null, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }, null, 2)}\n`);
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
  const platform = optionValue(args, "--platform");
  if (platform && !["macos", "ios", "appletvos", "visionos"].includes(platform)) {
    return { error: "xcode run altool --platform must be macos, ios, appletvos, or visionos" };
  }
  const providerPublicId = optionValue(args, "--provider-public-id");
  if (args.includes("--no-wait") && kind !== "altool-upload") {
    return { error: "xcode run --no-wait applies only to --kind altool-upload" };
  }
  const noWait = args.includes("--no-wait") ? { wait: false } : {};
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
      ...(platform ? { platform: platform as "macos" | "ios" | "appletvos" | "visionos" } : {}),
      ...(optionValue(args, "--p8-file-path") ? { p8FilePath: optionValue(args, "--p8-file-path")! } : {}),
      ...(providerPublicId ? { providerPublicId } : {}),
      ...noWait
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
    ...(platform ? { platform: platform as "macos" | "ios" | "appletvos" | "visionos" } : {}),
    ...(providerPublicId ? { providerPublicId } : {}),
    ...noWait
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

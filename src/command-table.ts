import { defineCli, defineCommand, type FlagSpec } from "./ouro-ax/command.ts";
import { defineExitCodes } from "./ouro-ax/exit-codes.ts";
import { EXIT_CODE_TABLE } from "./exit-codes.ts";

const flag = (type: FlagSpec["type"], description: string, extra: Partial<FlagSpec> = {}): FlagSpec => ({ type, description, ...extra });

const manifest = flag("string", "Path to the manifest. Defaults to distribution/apple-distribution.json.");
const config = flag("string", "Path to the config file with the App Store Connect API key settings.");
const teamId = flag("string", "The Apple Developer team id.", { required: true });
const sessionFile = flag("string", "A private session file made by `developer session import`.", { required: true });
const environment = flag("string", "A label for the environment, such as test.", { required: true });
const planFile = flag("string", "A private plan file made by a plan command.", { required: true });
const retries = flag("number", "How many times to retry a failed App Store Connect call.", { min: 1, max: 10 });

export const commands = [
  defineCommand({
    name: "manifest validate",
    summary: "Validate the distribution manifest and say whether it is valid.",
    effect: "private",
    readOnly: true,
    flags: { manifest },
    output: "{ ok, manifestPath }",
  }),
  defineCommand({
    name: "plan",
    summary: "Build a machine-readable distribution plan.",
    effect: "private",
    flags: { manifest, mode: flag("enum", "dry-run or apply.", { values: ["dry-run", "apply"] }) },
  }),
  defineCommand({
    name: "store review-plan",
    summary: "Build App Store review-prep actions and blockers. Reads the manifest only.",
    effect: "private",
    readOnly: true,
    flags: { channel: flag("string", "The channel id in the manifest.", { required: true }), manifest, artifact: flag("string", "A built package to check.") },
  }),
  defineCommand({
    name: "testflight plan",
    summary: "Build TestFlight publish actions and blockers. Reads the manifest only.",
    effect: "private",
    readOnly: true,
    flags: { channel: flag("string", "The channel id in the manifest.", { required: true }), manifest, artifact: flag("string", "A built package to check.") },
  }),
  defineCommand({
    name: "testflight publish",
    summary: "Build or apply TestFlight App Store Connect requests. Apply changes beta groups and builds other testers see.",
    effect: "others",
    why: "required",
    flags: {
      channel: flag("string", "The channel id in the manifest.", { required: true }),
      "app-id": flag("string", "The App Store Connect app id.", { required: true }),
      "build-id": flag("string", "The processed build id.", { required: true }),
      mode: flag("enum", "dry-run builds the requests; apply sends them.", { values: ["dry-run", "apply"] }),
      manifest,
      config,
      artifact: flag("string", "The built package."),
      "group-id": flag("list", "name=id of a beta group."),
      "build-beta-detail-id": flag("string", "The build's beta detail id."),
      "beta-app-review-detail-id": flag("string", "The beta app review detail id."),
    },
  }),
  defineCommand({
    name: "xcode run",
    summary: "Build or run Apple toolchain commands. Apply can upload or notarize, which other people see.",
    effect: "others",
    why: "required",
    flags: {
      kind: flag("enum", "The toolchain command.", {
        required: true,
        values: ["codesign", "productbuild", "notary-submit", "stapler", "stapler-validate", "spctl", "altool-validate", "altool-upload"],
      }),
      mode: flag("enum", "dry-run prints the command; apply runs it.", { values: ["dry-run", "apply"] }),
      path: flag("string", "The file to act on."),
      "package-path": flag("string", "The package to upload or validate."),
      platform: flag("string", "macos, ios, appletvos or visionos, for altool."),
    },
  }),
  defineCommand({
    name: "asc smoke",
    summary: "Verify App Store Connect API credentials without printing secrets.",
    effect: "private",
    readOnly: true,
    flags: { config },
  }),
  defineCommand({
    name: "asc get",
    summary: "GET an App Store Connect API path with authenticated, redacted output.",
    effect: "private",
    readOnly: true,
    flags: {
      path: flag("string", "The API path, such as /v1/apps.", { required: true }),
      query: flag("list", "name=value query parameters."),
      config,
    },
  }),
  defineCommand({
    name: "review status",
    summary: "Read the App Review state of every App Store version and review submission for one bundle id.",
    effect: "private",
    readOnly: true,
    flags: { "bundle-id": flag("string", "The app's bundle id.", { required: true }), platform: flag("string", "IOS or MAC_OS."), config },
  }),
  defineCommand({
    name: "review login-services",
    summary: "Run the Guideline 4.8 pre-submission check on a project folder. Exits 1 on any finding.",
    effect: "private",
    readOnly: true,
    flags: { root: flag("string", "The project folder. Defaults to the current folder.") },
  }),
  defineCommand({
    name: "signing create-certificate",
    summary: "Create the long-lived CI signing certificate once.",
    effect: "others",
    why: "required",
    flags: {
      "out-dir": flag("string", "Where the key and certificate are written.", { required: true }),
      "certificate-type": flag("string", "The certificate type, such as DISTRIBUTION."),
      "common-name": flag("string", "The certificate's common name."),
      openssl: flag("string", "The openssl binary to use."),
      config,
    },
  }),
  defineCommand({
    name: "signing import",
    summary: "Import the CI certificate into a keychain from named environment variables.",
    effect: "private",
    flags: {
      keychain: flag("string", "The keychain path.", { required: true }),
      state: flag("string", "The signing state file.", { required: true }),
      "p12-base64-env": flag("string", "The env var holding the base64 .p12."),
      "password-env": flag("string", "The env var holding the .p12 password."),
    },
  }),
  defineCommand({
    name: "signing profiles",
    summary: "Fetch provisioning profiles and write the signing settings for a build.",
    effect: "others",
    why: "required",
    flags: {
      state: flag("string", "The signing state file.", { required: true }),
      "team-id": flag("string", "The team id.", { required: true }),
      "bundle-id": flag("list", "A bundle id to fetch a profile for.", { required: true }),
      xcconfig: flag("string", "Where the xcconfig is written.", { required: true }),
      "export-options": flag("string", "Where the export options plist is written.", { required: true }),
      "export-options-base": flag("string", "An export options plist to start from."),
      "profile-type": flag("string", "The profile type."),
    },
  }),
  defineCommand({
    name: "signing delete-keychain",
    summary: "Delete the CI keychain.",
    effect: "private",
    flags: { keychain: flag("string", "The keychain path.", { required: true }) },
  }),
  defineCommand({
    name: "signing snapshot-certificates",
    summary: "Write the ids of the account's signing certificates to a file, as a baseline.",
    effect: "private",
    readOnly: true,
    flags: { out: flag("string", "Where the snapshot is written.", { required: true }), retries, config },
  }),
  defineCommand({
    name: "signing revoke-api-certificates",
    summary: "Revoke the API certificates created since a baseline. Revocation affects other people's builds.",
    effect: "others",
    why: "required",
    flags: {
      baseline: flag("string", "The snapshot taken before the run.", { required: true }),
      "dry-run": flag("boolean", "List what would be revoked, and revoke nothing."),
      "best-effort": flag("boolean", "Warn instead of failing when revocation fails."),
      retries,
      config,
    },
  }),
  defineCommand({
    name: "developer session import",
    summary: "Import a developer portal session from a private input into a private session file.",
    effect: "private",
    flags: { "team-id": teamId, "session-file": sessionFile, input: flag("string", "A private input file, or - for stdin.") },
  }),
  defineCommand({
    name: "developer status",
    summary: "Check whether the imported developer portal session still works.",
    effect: "private",
    readOnly: true,
    flags: { "team-id": teamId, "session-file": sessionFile },
  }),
  defineCommand({
    name: "developer keys list",
    summary: "List the developer portal keys for a team.",
    effect: "private",
    readOnly: true,
    flags: { "team-id": teamId, "session-file": sessionFile },
  }),
  defineCommand({
    name: "developer keys get",
    summary: "Read one developer portal key.",
    effect: "private",
    readOnly: true,
    flags: { "team-id": teamId, "session-file": sessionFile, "key-id": flag("string", "The key id.", { required: true }) },
  }),
  defineCommand({
    name: "developer keys plan",
    summary: "Plan a developer portal key create, revoke or download, and write the plan to a private file.",
    effect: "private",
    flags: {
      "team-id": teamId,
      "session-file": sessionFile,
      action: flag("enum", "create, revoke or download.", { required: true, values: ["create", "revoke", "download"] }),
      environment,
      "primary-app-id": flag("string", "The primary app id."),
      "primary-app-identifier": flag("string", "The primary app bundle identifier."),
      "key-name": flag("string", "The key's name."),
      "key-id": flag("string", "The key id, for revoke or download."),
      output: flag("string", "Where the plan is written."),
    },
  }),
  defineCommand({
    name: "developer keys apply",
    summary: "Apply a developer portal key plan. Creates or revokes keys other people's builds use.",
    effect: "others",
    why: "required",
    flags: { "team-id": teamId, environment, "session-file": sessionFile, "plan-file": planFile },
  }),
  defineCommand({
    name: "developer keys reconcile",
    summary: "Reconcile a developer portal key plan with the portal, reading the portal first. Applies what is missing.",
    effect: "others",
    why: "required",
    flags: { "team-id": teamId, environment, "session-file": sessionFile, "plan-file": planFile },
  }),
  defineCommand({
    name: "developer services get",
    summary: "Read one developer portal Services ID.",
    effect: "private",
    readOnly: true,
    flags: {
      "team-id": teamId,
      "session-file": sessionFile,
      "service-id": flag("string", "The Services ID.", { required: true }),
      identifier: flag("string", "The expected client id.", { required: true }),
    },
  }),
  defineCommand({
    name: "developer services plan",
    summary: "Plan the developer portal Services IDs against a desired config, and write the plan to a private file.",
    effect: "private",
    flags: { "team-id": teamId, environment, "session-file": sessionFile, "plan-file": planFile, config: flag("string", "The private desired-state JSON.", { required: true }) },
  }),
  defineCommand({
    name: "developer services apply",
    summary: "Apply a developer portal Services ID plan. Changes sign-in configuration other people use.",
    effect: "others",
    why: "required",
    flags: { "team-id": teamId, environment, "session-file": sessionFile, "plan-file": planFile },
  }),
  defineCommand({
    name: "developer services reconcile",
    summary: "Reconcile a developer portal Services ID plan with the portal. Applies what is missing.",
    effect: "others",
    why: "required",
    flags: { "team-id": teamId, environment, "session-file": sessionFile, "plan-file": planFile },
  }),
];

export const cli = defineCli({
  name: "apple-distribution-kit",
  about: [
    "Apple distribution automation for native apps: manifest checks, App Store Connect, TestFlight, signing and Apple Developer setup.",
    "Every command is listed here, with whether it only reads or changes something other people see.",
  ],
  exits: defineExitCodes(EXIT_CODE_TABLE),
  groups: {
    asc: "Check App Store Connect credentials, and read an API path (asc smoke, asc get)",
    developer: "Apple Developer portal: session, keys and Services IDs (status, keys, services)",
    review: "App Review: state of each version (status), and the Guideline 4.8 login check (login-services)",
    signing: "Long-lived CI signing: certificate, keychain, profiles, and certificate revocation",
    store: "App Store review preparation (review-plan)",
    testflight: "TestFlight: plan and publish builds to beta groups",
    xcode: "Apple toolchain commands, behind an explicit mode gate",
  },
  commands,
});

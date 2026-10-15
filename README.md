<!-- ourostack:brand:start -->
<p align="center">
  <a href="https://github.com/ourostack"><img src="https://raw.githubusercontent.com/ourostack/.github/main/brand/ouro.png" alt="Ourostack" width="96" height="96"></a>
</p>
<!-- ourostack:brand:end -->

# apple-distribution-kit

Reusable Apple distribution automation for native apps.

## Manifest Contract

Apps declare distribution intent in `distribution/apple-distribution.json`.
The kit currently supports:

- `developer-id` for signed/notarized direct-download macOS apps.
- `app-store` for macOS App Store review preparation.
- `testflight` for iOS TestFlight upload and beta publishing.

TestFlight channels are explicit about beta groups, tester notes, beta app
metadata, and external beta review contact details:

```json
{
  "id": "ios-testflight",
  "platform": "ios",
  "distribution": "testflight",
  "bundleId": "app.example",
  "buildCommand": "yarn build && yarn cap sync",
  "packageCommand": "xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Release archive",
  "store": {
    "version": "1.0",
    "copyright": "Copyright 2026 Example",
    "category": "FOOD_AND_DRINK",
    "privacy": {
      "policyUrl": "https://example.app/privacy",
      "collectsData": true
    },
    "exportCompliance": {
      "usesEncryption": true,
      "exempt": true
    }
  },
  "testflight": {
    "groups": [
      { "name": "Example Internal", "type": "internal", "feedbackEnabled": true },
      {
        "name": "Example Friends",
        "type": "external",
        "publicLinkEnabled": true,
        "publicLinkLimitEnabled": true,
        "publicLinkLimit": 100,
        "feedbackEnabled": true
      }
    ],
    "build": {
      "whatsNew": "Try the first beta flow.",
      "autoNotifyEnabled": false,
      "notifyTesters": false
    },
    "betaApp": {
      "description": "A short beta-facing app description.",
      "feedbackEmail": "beta@example.app",
      "marketingUrl": "https://example.app"
    },
    "betaReview": {
      "contactFirstName": "Ari",
      "contactLastName": "Mendelow",
      "contactPhone": "+12065550100",
      "contactEmail": "ari@example.com",
      "demoAccountRequired": false,
      "notes": "No login required for this beta build."
    }
  }
}
```

## TestFlight Lane

Validate and inspect the lane before touching Apple:

```bash
apple-distribution-kit manifest validate --manifest distribution/apple-distribution.json
apple-distribution-kit testflight plan --channel ios-testflight --manifest distribution/apple-distribution.json --json
```

Upload the processed IPA with App Store Connect API auth:

```bash
apple-distribution-kit xcode run \
  --kind altool-upload \
  --mode apply \
  --package-path build/Spoonjoy.ipa \
  --platform ios \
  --api-key "$APP_STORE_CONNECT_KEY_ID" \
  --api-issuer "$APP_STORE_CONNECT_ISSUER_ID" \
  --p8-file-path "$APP_STORE_CONNECT_KEY_PATH" \
  --provider-public-id "$APPLE_PROVIDER_PUBLIC_ID" \
  --json
```

Use authenticated `asc get` calls to find the App Store Connect IDs needed for
publishing:

```bash
apple-distribution-kit asc get \
  --path /v1/apps \
  --query 'filter[bundleId]=app.example' \
  --query 'limit=1' \
  --json

apple-distribution-kit asc get \
  --path /v1/builds \
  --query "filter[app]=$ASC_APP_ID" \
  --query 'filter[preReleaseVersion.platform]=IOS' \
  --query 'filter[processingState]=VALID' \
  --query 'sort=-uploadedDate' \
  --json

apple-distribution-kit asc get --path "/v1/apps/$ASC_APP_ID/betaGroups" --json
apple-distribution-kit asc get --path "/v1/apps/$ASC_APP_ID/betaAppReviewDetail" --json
```

After App Store Connect reports a `VALID` build, dry-run the beta publishing
requests. Pass existing group IDs with `--group-id name=id`; groups omitted here
are created and attached to the build by the generated requests.

```bash
apple-distribution-kit testflight publish \
  --mode dry-run \
  --manifest distribution/apple-distribution.json \
  --channel ios-testflight \
  --app-id "$ASC_APP_ID" \
  --build-id "$ASC_BUILD_ID" \
  --build-beta-detail-id "$ASC_BUILD_BETA_DETAIL_ID" \
  --beta-app-review-detail-id "$ASC_BETA_APP_REVIEW_DETAIL_ID" \
  --group-id "Example Internal=$ASC_INTERNAL_GROUP_ID" \
  --artifact artifacts/testflight-publish-plan.json \
  --json
```

Apply the same request set only after the dry run looks right:

```bash
apple-distribution-kit testflight publish \
  --mode apply \
  --manifest distribution/apple-distribution.json \
  --channel ios-testflight \
  --app-id "$ASC_APP_ID" \
  --build-id "$ASC_BUILD_ID" \
  --build-beta-detail-id "$ASC_BUILD_BETA_DETAIL_ID" \
  --beta-app-review-detail-id "$ASC_BETA_APP_REVIEW_DETAIL_ID" \
  --group-id "Example Internal=$ASC_INTERNAL_GROUP_ID" \
  --json
```

The TestFlight request builder covers the App Store Connect resources exposed by
Apple's OpenAPI spec: beta groups, beta build localizations, build beta details,
beta app review details/submissions, and build beta notifications.

## CI Signing

Ephemeral CI runners start with an empty keychain. If `xcodebuild -allowProvisioningUpdates` runs there with an App
Store Connect API key, Xcode creates a new "Created via API" development certificate on every run, Apple emails the
team for each one, and the provisioning fetch inside Xcode becomes a failure point ("The network connection was lost",
then "No profiles for ..."). The `signing` commands replace that with one long-lived Apple Distribution certificate
stored as CI secrets. A normal run creates no certificate and `xcodebuild` makes no Apple network calls.

### Secrets

| Secret | Contents |
| --- | --- |
| `APPLE_DISTRIBUTION_CERTIFICATE_P12_BASE64` | Base64 of the p12 holding the Apple Distribution certificate and its private key |
| `APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD` | The p12 password |
| `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_API_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY_BASE64` | The App Store Connect API key, written to the kit config file as in the TestFlight lane |

One Apple Distribution certificate signs every iOS and macOS App Store build for the team, so store it once as
organization secrets where the organization allows it, and as repository secrets in repositories outside that
organization. Apple allows only a few distribution certificates per team, so reuse this one rather than creating one per
app.

### Create the certificate (once a year)

Run this on a trusted machine with the App Store Connect key config. It creates the certificate through the API, packs a
p12 with a random password and truncates the private key, CSR and intermediate files. It prints the certificate ID and
expiry, never a secret.

```bash
out="$(mktemp -d)"
apple-distribution-kit signing create-certificate --out-dir "$out"
gh secret set APPLE_DISTRIBUTION_CERTIFICATE_P12_BASE64 --org <org> --visibility all < "$out/certificate.p12.base64"
gh secret set APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD --org <org> --visibility all < "$out/certificate.password"
: > "$out/certificate.p12.base64"; : > "$out/certificate.password"
```

Use `--repo <owner/name>` instead of `--org` for a repository outside the organization. To renew, create a new
certificate and replace both secrets; the next run creates fresh profiles for it automatically.

### Use it in a workflow

```yaml
- name: Import long-lived signing identity
  env:
    APPLE_DISTRIBUTION_CERTIFICATE_P12_BASE64: ${{ secrets.APPLE_DISTRIBUTION_CERTIFICATE_P12_BASE64 }}
    APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD }}
  run: |
    node "$APPLE_DISTRIBUTION_KIT_BIN" signing import \
      --keychain "$RUNNER_TEMP/adk-signing.keychain-db" \
      --state "$RUNNER_TEMP/adk-signing/state.json"

- name: Install App Store provisioning profiles
  run: |
    node "$APPLE_DISTRIBUTION_KIT_BIN" signing profiles \
      --state "$RUNNER_TEMP/adk-signing/state.json" \
      --team-id "$TEAM_ID" \
      --bundle-id app.example \
      --bundle-id app.example.widget \
      --xcconfig "$RUNNER_TEMP/adk-signing/signing.xcconfig" \
      --export-options "$RUNNER_TEMP/adk-signing/ExportOptions.plist" \
      --export-options-base distribution/ExportOptions.testflight.plist

- name: Archive and export
  run: |
    xcodebuild -project App.xcodeproj -scheme App -configuration Release \
      -destination generic/platform=iOS -archivePath build/App.xcarchive \
      -xcconfig "$RUNNER_TEMP/adk-signing/signing.xcconfig" archive
    xcodebuild -exportArchive -archivePath build/App.xcarchive -exportPath build/export \
      -exportOptionsPlist "$RUNNER_TEMP/adk-signing/ExportOptions.plist"

- name: Revoke API-created development certificates (safety net)
  if: always()
  run: node "$APPLE_DISTRIBUTION_KIT_BIN" signing revoke-api-certificates --best-effort

- name: Delete signing keychain
  if: always()
  run: node "$APPLE_DISTRIBUTION_KIT_BIN" signing delete-keychain --keychain "$RUNNER_TEMP/adk-signing.keychain-db"
```

What each command does:

- `signing import` creates a temporary keychain with a random password, imports the p12 from the two environment
  variables (rename them with `--p12-base64-env` and `--password-env`), adds the keychain to the search list and writes
  the identity's SHA-1, serial and expiry to the state file.
- `signing profiles` finds the certificate by serial, then for each `--bundle-id` reuses the active profile named
  `ADK CI <bundle id> <certificate id>` or creates it (deleting an invalid or expiring one with that name first). It
  installs the profiles where Xcode looks for them, writes an xcconfig that switches every target to manual signing
  and picks each target's profile by bundle identifier, and writes manual export options over `--export-options-base`.
  List every signed target's bundle identifier, including app extensions. The default profile type is `IOS_APP_STORE`.
- Every GET and DELETE to App Store Connect is retried on network loss or a retryable status, 4 attempts in total by
  default with backoff from 2 seconds (`--retries <n>` changes the attempt count). Creating a certificate or profile is
  never retried, so a lost response cannot create a duplicate.
- `signing revoke-api-certificates` is the safety net. It revokes only development certificates named "Created via
  API", never distribution, Developer ID, Mac or personal certificates, and says `Nothing to revoke` on a normal run.
  `--dry-run` lists what it would revoke.
- `signing delete-keychain` removes the temporary keychain and its search-list entry.

Do not pass `-allowProvisioningUpdates` or API key arguments to `xcodebuild` with this setup; nothing in the archive or
export needs Apple's servers.
# Apple Developer inspection and guarded SIWA keys

The separate `developer` command family uses an explicitly enrolled Apple Developer
web session, **not** App Store Connect JWT credentials. Inspection stays read-only;
separate private plan/apply/reconcile commands support scoped Sign in with Apple
key creation, revocation and one-time download. This layer cannot change Services
IDs or accept agreements.
Existing ASC and signing commands are unchanged. Node 22 or newer is required.
This Developer credential-store milestone supports **macOS and Linux only**.
Windows and other platforms fail closed with `unsupported_platform` before
reading stdin/files, enrolling/loading credentials, refreshing the store or
extracting credential headers. No Windows ACL credential-store adapter exists.

```sh
# Create a private destination directory (not inside a source checkout).
mkdir -m 700 "$HOME/.apple-developer-session"

# Enrollment is local only: no Apple request is made by import.
apple-distribution-kit developer session import \
  --team-id TEAM123456 \
  --session-file "$HOME/.apple-developer-session/session.json" \
  --input "$HOME/.apple-developer-session/enrollment.json" --json

# --input - (or omitted --input) consumes the same JSON from stdin.
apple-distribution-kit developer status \
  --team-id TEAM123456 --session-file "$HOME/.apple-developer-session/session.json" --json
apple-distribution-kit developer keys list \
  --team-id TEAM123456 --session-file "$HOME/.apple-developer-session/session.json" --json
apple-distribution-kit developer keys get --key-id ABC123DE45 \
  --team-id TEAM123456 --session-file "$HOME/.apple-developer-session/session.json" --json
```

Every command requires an explicit ten-character uppercase alphanumeric team ID and
an explicit private session file; `keys get` also requires a key ID of the same syntax.
Unknown, duplicate and missing options are errors. Never put cookie values in arguments.
The enrollment input is a private file or stdin containing:

```ts
{
  teamId: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    expires: number; // CDP seconds since epoch; -1 means session cookie
    sameSite?: "Strict" | "Lax" | "None";
  }>;
}
```

Enrollment rejects expired, insecure or out-of-scope cookies. Only cookies eligible
for `https://developer.apple.com/services-account/QH65B2/` are accepted, with
domain/path/expiry semantics supplied by `tough-cookie`. No browser profiles are
enumerated, decrypted or imported. The input and destination must have private,
non-symlink parents; on POSIX their immediate parent must be owned by the current
user and have no group/world permissions. Files must be regular, owner-only,
current-user-owned and not hardlinked. Enrollment never overwrites an existing
destination: choose a new destination when manually re-enrolling.

The session store is **plaintext owner-only local storage**, not encryption or
Keychain storage. Keep both enrollment and store files outside Git, never share
them, and retire old files according to your local credential-handling policy.
POSIX ownership/mode checks are enforced on macOS/Linux. Windows is explicitly
refused at runtime, not permitted with weakened file checks.

`status` performs an actual scoped key-list read and returns `{ ready: true, teamId }`
only after HTTP 200, a JSON schema with numeric `resultCode: 0`, and valid keys.
List uses 50 keys per page, rejects duplicate/non-progressing pages, and fails
instead of silently returning partial data at the 100-page limit. Get verifies the
returned key ID. Summaries contain only `keyId`, `keyName`, validated `serviceIds`,
`canDownload` and `canRevoke`; service configurations, creator identity and private
key payloads are never returned.

Only the supported pinned Developer paths receive credentials; no arbitrary URL,
mutation path or raw request interface is exported. Redirects are
never followed, each request has a 15-second timeout, and exceptions/server strings
are replaced by stable `DeveloperError.code` values. HTTP 401, recognized Apple
login redirects and HTML responses require manual sign-in; an empty/expired jar
also returns a native `RequiresHuman` sign-in gate. HTTP 403 is `permission_denied`,
not assumed to be 2FA. The verified numeric Apple `resultCode: 2100` returns
`agreement_required` with a native manual `RequiresHuman` agreement gate at
`https://developer.apple.com/register/agree/`. Unknown other nonzero result codes
remain sanitized `apple_error`; server text is never used to guess sign-in,
2FA or agreement gates. Agreement acceptance is always manual; no agreement is
accepted by this layer.

Eligible secure `Set-Cookie` updates on validated successful responses are
atomically persisted in the private store. A detected change to the loaded store
is not overwritten. Refresh acquires an exclusive owner-only
`<session-file>.refresh.lock` before re-reading, comparing or replacing the store.
Contention returns sanitized `session_store_busy` (CLI exit 69), without changing
the store or removing another command's lock. Successful and failed refreshes
release only the exact acquired lock, verified by its open descriptor's identity.
Existing locks, including stale locks left by an interrupted process, are never
automatically broken; confirmed abandoned locks require explicit local recovery.
Session cookies retain browser-style session-cookie lifetime until Apple rejects
them; persisted enrollment does not confer a new authenticated lifetime. Expiry,
server-side invalidation, MFA or changed agreements may require signing in again
and enrolling a fresh session. There is no promise of avoiding 2FA, and no
password/2FA/CAPTCHA automation.

Library usage:

```ts
import { createDeveloperClient, loadDeveloperSession, DeveloperError } from "apple-distribution-kit";

const teamId = "TEAM123456";
const session = loadDeveloperSession({ teamId, sessionFile: privatePath });
const client = createDeveloperClient({ teamId, session });
try {
  const status = await client.status();
  const keys = await client.keys.list();
  const key = await client.keys.get("ABC123DE45");
} catch (error) {
  if (error instanceof DeveloperError) {
    // Inspect the stable code / optional native requiresHuman; never dump credentials.
  }
}
```

JSON CLI success uses `{ ok: true, result }`; errors use
`{ ok: false, error: { code, message, requiresHuman? } }`. Invalid arguments exit
64, and failed inspection or a human gate exits 69. Import reports only enrollment,
not live readiness. Neither library nor CLI returns arbitrary portal JSON.

## SIWA plan / apply / reconcile

These commands bind one explicit team, primary internal App ID, unprefixed primary
bundle identifier and declared environment. **Environment is a bounded intent
label, not an Apple-side test/production barrier.** The resource verification is
the barrier: the primary's JSON API type/ID/identifier/seed must match, and an
existing key must have exactly one SIWA service and exactly one directly matching
`bundle` configuration. Additional services/configurations, related keys and
enabled non-SIWA capability flags are refused rather than silently dropped.

All examples below use illustrative IDs; supply your approved exact resources.
Use a private directory outside Git for the session, plan and output.

```sh
apple-distribution-kit developer keys plan \
  --action create --key-name "Example SIWA key" \
  --team-id TEAM123456 --environment test \
  --primary-app-id APP1234567 --primary-app-identifier org.example.primary \
  --session-file "$HOME/.apple-developer-session/session.json" \
  --plan-file "$HOME/.apple-developer-session/create-plan.json" --json

apple-distribution-kit developer keys apply \
  --team-id TEAM123456 --environment test \
  --session-file "$HOME/.apple-developer-session/session.json" \
  --plan-file "$HOME/.apple-developer-session/create-plan.json" --json

apple-distribution-kit developer keys reconcile \
  --team-id TEAM123456 --environment test \
  --session-file "$HOME/.apple-developer-session/session.json" \
  --plan-file "$HOME/.apple-developer-session/create-plan.json" --json
```

For revocation, plan with `--action revoke --key-id <id>` instead of `--key-name`.
For a one-time download, plan with `--action download --key-id <id> --output
<private-new-destination>`. Both still require the exact primary ID/identifier,
team, environment, session and plan file. Only create accepts `--key-name`; only
download accepts/requires `--output`. Apply/reconcile accept no target, action,
name, primary or destination overrides. Unknown/duplicate/missing options fail
before transport.

Plan performs only semantically read-only requests and creates an exclusive
owner-only artifact. It never creates/revokes/downloads a vendor key. Plans carry
an operation UUID, canonical SHA-256 integrity hash, exact scope/resource
fingerprint and (for create) the permission-selected legacy/v2 payload. Apply
checks integrity, re-reads the primary/key preconditions and named permission
flags, and refuses stale plans rather than selecting a different creation
version. A fresh scoped inventory supplies in-memory `csrf` / `csrf_ts` immediately
before the effect. Tokens never enter plans or receipts.

The stable private operation directory is
`$HOME/.apple-distribution-kit/developer-operations/<team-id>/`. Cooperating kit
commands share its exclusive owned team lock and resource indexes across session
clones, plan nonces and environment labels. A private intent is written/fsynced
before any effect; sanitized receipts are atomically persisted afterward. Keep
this directory and its intents/indexes: deleting or moving the whole authority
directory defeats local replay protection. Unknown outcomes, missing/corrupt
referenced intents and stale/foreign/replaced locks fail closed. No command
automatically breaks a stale lock.
Each authority hierarchy entry is made durable by fsyncing its containing
directory before proceeding, including entries adopted after an interrupted
creation. Directory descriptors close even when fsync fails, and a failed
durability barrier prevents vendor effects.

There is **no automatic retry** of create, revoke or download, including network,
HTTP, body/schema, postcondition or post-request disk failures. An unresolved
same-resource effect also blocks fresh plans; pending is not treated as absent.
Completed replays return the persisted receipt without vendor I/O. Reconcile is
read-only: a uniquely named, exactly bound created key can settle creation; a
complete inventory proving exact target absence can settle revocation. No visible
match after uncertain creation does not authorize another create. A later
intentional same-name creation requires the earlier operation settled and the
earlier created resource verified absent.
Reconciliation preserves sanitized error codes and native agreement/sign-in
human gates while retaining `state: "uncertain"` and CLI exit 69; it never
retries a key mutation to recover from an authentication or persistence failure.

Download exclusively reserves a new owner-only regular destination before the
one-time GET. Existing files, links and permissive destinations are never
overwritten. The bounded response must parse as a PKCS#8 EC/P-256 private key;
content/hash and owned file identity are checked after fsynced persistence.
A private operation-local recovery artifact is persisted before writing the final
destination, so final-destination disk failure retains private recovery material.
Its pointer is in the private journal, **never in public receipts**. An uncertain
download cannot be reconstructed from inventory and is never requested again,
including during reconcile. Local recovery requires explicit inspection of the
private artifacts; the kit has no retry/unlock/recovery mutation command.

Exact library entry points:

```ts
import {
  planDeveloperKey, applyDeveloperKey, reconcileDeveloperKey,
  type DeveloperKeyPlanOptions, type DeveloperKeyScope
} from "apple-distribution-kit";

const input: DeveloperKeyPlanOptions = {
  action: "create", keyName: "Example SIWA key",
  teamId: "TEAM123456", environment: "test",
  primaryAppId: "APP1234567", primaryAppIdentifier: "org.example.primary",
  sessionFile: privateSessionPath, planFile: privatePlanPath
};
const planned = await planDeveloperKey(input); // Promise<DeveloperKeyPlanSummary>
const scope: DeveloperKeyScope = {
  teamId: input.teamId, environment: input.environment,
  sessionFile: input.sessionFile, planFile: input.planFile
};
const applied = await applyDeveloperKey(scope); // Promise<DeveloperKeyReceipt>
const reconciled = await reconcileDeveloperKey(scope); // Promise<DeveloperKeyReceipt>
```

`DeveloperKeyPlanOptions` is a discriminated union: create requires `keyName`,
revoke requires `keyId`, and download requires `keyId` plus `output`. `fetch` is an
optional injected transport on scope/options (useful for offline tests); it never
changes the pinned destination contracts or permits automatic retries.
Summaries/receipts allowlist only operation/scope/resource metadata, with a
download SHA-256 on verified completion. They never contain creator metadata,
raw vendor responses, cookies, CSRF, PEM, destinations or recovery paths.
Uncertainty returns `{ ok: false, result: { state: "uncertain", ... } }` and exit
69, optionally with a sanitized `errorCode` and native `requiresHuman` gate.
Pre-effect refusals use the existing error envelope. An agreement-required
response remains an explicit manual gate, never authorization to accept terms.
This includes numeric `2100` in a non-PEM download error body; JSON is never
accepted as a successful private-key download.

### Existing Services IDs

Services ID inspection and guarded configuration use the same private Developer
session, pinned transport and durable operation helpers as the key lifecycle.
These commands operate on **existing** Services IDs only: there is no create,
delete, generic PATCH, unrelated capability disable, consent-grant or team
capability operation.

```sh
apple-distribution-kit developer services get \
  --team-id TEAM123456 \
  --session-file "$HOME/.apple-developer-session/session.json" \
  --service-id SVC1234567 --identifier org.example.web --json

apple-distribution-kit developer services plan \
  --team-id TEAM123456 --environment test \
  --session-file "$HOME/.apple-developer-session/session.json" \
  --plan-file "$HOME/.apple-developer-session/service-plan.json" \
  --config "$HOME/.apple-developer-session/service-desired.json" --json

apple-distribution-kit developer services apply \
  --team-id TEAM123456 --environment test \
  --session-file "$HOME/.apple-developer-session/session.json" \
  --plan-file "$HOME/.apple-developer-session/service-plan.json" --json

apple-distribution-kit developer services reconcile \
  --team-id TEAM123456 --environment test \
  --session-file "$HOME/.apple-developer-session/session.json" \
  --plan-file "$HOME/.apple-developer-session/service-plan.json" --json
```

The owner-only, nonsymlink desired JSON accepts exactly these six properties:

```json
{
  "serviceId": "SVC1234567",
  "identifier": "org.example.web",
  "primaryAppId": "APP1234567",
  "primaryAppIdentifier": "org.example.primary",
  "domains": ["login.example.org"],
  "returnUrls": ["https://login.example.org/Callback%2FExact?x=%2f"]
}
```

Scope comes from the explicit team/environment arguments, never from the config.
The environment label describes intended scope; it does not provide Apple-side
isolation. Both resource IDs are Apple's internal IDs; identifiers are separate,
unprefixed client/bundle identifiers. Inspection validates the exact Services ID,
team seed, `SERVICES` platform and exact SIWA capability reference, then separately
reads its associated primary to verify team and identifier. It uses the complete
parent include graph, not an unsupported leaf capability GET.

Domains and return URLs must be nonempty unique lists (at most 100 each).
Domains are normalized to lowercase and sorted; URL lists are sorted without
rewriting callback path/query spelling. Domains must be valid dotted hostnames,
not IP addresses, wildcards or local/private-use names. Return URLs must be
absolute HTTPS with an explicitly declared hostname, no userinfo, fragment,
nondefault port, control characters or malformed escapes. Supplied URLs are
never fetched. Unknown config fields and unsafe/ambiguous input fail before
network access.

Planning performs read-only parent/primary requests and exclusively publishes a
versioned, hashed private plan. The plan binds exact scope, identifiers, desired
lists and fingerprints of the current and intended complete relevant
configuration. Apply re-reads those preconditions and the desired primary's
ownership before any effect. It PATCHes the **parent** JSON API bundle resource,
retaining parent metadata and unrelated capability enabled states, inputs,
settings and primary associations. Unrecognized configuration shapes fail
closed rather than being silently dropped. Display-only input metadata is not
submitted as configuration.
Known read-only dates, response IDs, labels and validated navigation-only
`meta`/`links` relationships are accepted but are neither PATCHed nor used as
configuration fingerprints. Required resource relationships still need exact
`data` linkage. Unfamiliar relationship `data`, explicitly reported unexpanded
associations and unsupported non-null configuration fields fail closed. An
explicit SIWA `editable: false` permits inspection and verified no-op but blocks
effectful planning/apply before intent or PATCH.

Private service intents and resource indexes live at
`$HOME/.apple-distribution-kit/developer-services-operations/<team-id>/`.
This is a separate resource namespace, using the key lifecycle's shared
fsynced publication, integrity/index validation, private-directory and owned-lock
mechanisms. Keep it intact. A pending/uncertain service intent blocks all new
plans for that service across session clones and environment labels. Completed
or no-op replay does not erase other pending history.

An already exact configuration produces `noOp: true`; apply verifies it and
persists completion without PATCH. Otherwise completion requires a fresh parent
include-graph/primary read confirming the exact requested configuration **and**
unchanged unrelated capabilities and parent metadata. Unknown HTTP, network,
body, postcondition or persistence outcomes remain `state: "uncertain"` with no
automatic PATCH retry. Read-only reconcile can verify the full intended
postcondition or retain uncertainty; agreement/sign-in failures keep their
native manual gates. CLI uncertainty is `{ok:false,result:{state:"uncertain",
...}}` with exit 69. Pre-effect refusals use the existing sanitized error
envelope. Public outputs contain resource/configuration metadata, never cookies,
CSRF, raw server objects, creator information or private paths.

The resource-bound library interfaces are:

```ts
import {
  getDeveloperService, planDeveloperService,
  applyDeveloperService, reconcileDeveloperService,
  type DeveloperServiceGetOptions, type DeveloperServicePlanOptions,
  type DeveloperServiceScope
} from "apple-distribution-kit";

const inspection: DeveloperServiceGetOptions = {
  teamId: "TEAM123456", sessionFile: privateSessionPath,
  serviceId: "SVC1234567", identifier: "org.example.web"
};
await getDeveloperService(inspection); // Promise<DeveloperServiceSummary>

const scope: DeveloperServiceScope = {
  teamId: inspection.teamId, sessionFile: inspection.sessionFile,
  environment: "test", planFile: privatePlanPath
};
const input: DeveloperServicePlanOptions = {
  ...scope, serviceId: inspection.serviceId, identifier: inspection.identifier,
  primaryAppId: "APP1234567", primaryAppIdentifier: "org.example.primary",
  domains: ["login.example.org"],
  returnUrls: ["https://login.example.org/Callback%2FExact?x=%2f"]
};
await planDeveloperService(input); // Promise<DeveloperServicePlanSummary>
await applyDeveloperService(scope); // Promise<DeveloperServiceReceipt>
await reconcileDeveloperService(scope); // Promise<DeveloperServiceReceipt>
```

All options accept optional injected `fetch` for offline consumers without
changing the pinned destination/method contracts. Inspection returns
`teamId`, the six configuration fields and `enabled`. Plan summaries return the
six configuration fields plus `version:1`, `action:"configure-service"`,
`operationId`, `teamId`, `environment`, `planHash` and `noOp`. Receipts add
`state:"completed"|"uncertain"` and optional sanitized `errorCode` /
`requiresHuman`.

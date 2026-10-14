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
# Apple Developer read-only inspection

The separate `developer` command family uses an explicitly enrolled Apple Developer
web session, **not** App Store Connect JWT credentials. It only inspects authentication
keys; it cannot create, revoke or download keys, change Services IDs, or accept agreements.
Existing ASC and signing commands are unchanged. Node 22 or newer is required.

```sh
# Create a private destination directory (not inside a source checkout).
mkdir -m 700 "$HOME/.apple-developer-session"

# Enrollment is local only: no Apple request is made by import.
apple-distribution-kit developer session import \
  --team-id 743GT2AJ24 \
  --session-file "$HOME/.apple-developer-session/session.json" \
  --input "$HOME/.apple-developer-session/enrollment.json" --json

# --input - (or omitted --input) consumes the same JSON from stdin.
apple-distribution-kit developer status \
  --team-id 743GT2AJ24 --session-file "$HOME/.apple-developer-session/session.json" --json
apple-distribution-kit developer keys list \
  --team-id 743GT2AJ24 --session-file "$HOME/.apple-developer-session/session.json" --json
apple-distribution-kit developer keys get --key-id ABC123DE45 \
  --team-id 743GT2AJ24 --session-file "$HOME/.apple-developer-session/session.json" --json
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
POSIX ownership/mode checks are not a Windows ACL guarantee; this milestone does
not supply a Windows platform credential-store adapter.

`status` performs an actual scoped key-list read and returns `{ ready: true, teamId }`
only after HTTP 200, a JSON schema with numeric `resultCode: 0`, and valid keys.
List uses 50 keys per page, rejects duplicate/non-progressing pages, and fails
instead of silently returning partial data at the 100-page limit. Get verifies the
returned key ID. Summaries contain only `keyId`, `keyName`, validated `serviceIds`,
`canDownload` and `canRevoke`; service configurations, creator identity and private
key payloads are never returned.

Only the pinned key-list/key-get POST paths receive credentials. Redirects are
never followed, each request has a 15-second timeout, and exceptions/server strings
are replaced by stable `DeveloperError.code` values. HTTP 401, recognized Apple
login redirects and HTML responses require manual sign-in; an empty/expired jar
also returns a native `RequiresHuman` sign-in gate. HTTP 403 is `permission_denied`,
not assumed to be 2FA. Unknown nonzero Apple result codes remain `apple_error`,
including unverified agreement responses: they are **not** guessed to be sign-in,
2FA or agreement gates. Agreement acceptance, if required by Apple, is always
manual; no agreement is accepted by this layer.

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

const teamId = "743GT2AJ24";
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

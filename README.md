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

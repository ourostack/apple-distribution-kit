<!-- ourostack:brand:start -->
<p align="center">
  <a href="https://github.com/ourostack"><img src="https://raw.githubusercontent.com/ourostack/.github/main/brand/headers/apple-distribution-kit.webp" alt="Ouro at a packing bench wrapping green gift boxes that roll down a conveyor into a red wagon" width="100%"></a>
</p>
<!-- ourostack:brand:end -->

# Apple distribution kit

**Sign, notarize and ship native Apple apps from one manifest: Developer ID downloads, App Store review and TestFlight.** One JSON file says where the app goes; the kit plans the trip and runs it.

[The manual](docs/manual.md) · [TestFlight lane](docs/manual.md#testflight-lane) · [CI signing](docs/manual.md#ci-signing) · [More from Ouro](https://github.com/ourostack)

**Status:** pre-1.0. There is no npm package or release yet, so you clone and build it. Node 22 or newer.

## Quick start

```sh
git clone https://github.com/ourostack/apple-distribution-kit
cd apple-distribution-kit && npm ci && npm run build && npm link
cd /path/to/your-app
apple-distribution-kit manifest validate   # reads distribution/apple-distribution.json
apple-distribution-kit plan                # what it would do, as a dry run
```

`npm link` puts the `apple-distribution-kit` command on your PATH; without it, run `node dist/cli.js` from the kit's folder.

## A minimal manifest

`distribution/apple-distribution.json` in your app:

```json
{
  "schemaVersion": 1,
  "app": { "name": "MyApp", "bundleId": "com.example.myapp" },
  "team": { "teamId": "ABCDE12345" },
  "channels": [{
    "id": "mac-download",
    "platform": "macos",
    "distribution": "developer-id",
    "bundleId": "com.example.myapp",
    "buildCommand": "xcodebuild -scheme MyApp -configuration Release archive",
    "packageCommand": "scripts/package-dmg.sh"
  }]
}
```

A channel's `distribution` is `developer-id` (a signed, notarized Mac download), `app-store` (Mac App Store review) or `testflight` (iOS beta).

## The manual

[docs/manual.md](docs/manual.md) has the rest:

- [Manifest Contract](docs/manual.md#manifest-contract): every field, with a full TestFlight channel.
- [TestFlight Lane](docs/manual.md#testflight-lane): upload, groups, tester notes and beta review.
- [App Review](docs/manual.md#app-review-watching-and-reading-rejections): watching a review and reading a rejection.
- [CI Signing](docs/manual.md#ci-signing): signing in CI with no certificate created per run.
- [Apple Developer inspection and guarded SIWA keys](docs/manual.md#apple-developer-inspection-and-guarded-siwa-keys): the `developer` commands.

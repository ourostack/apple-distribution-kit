import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCli } from "../src/cli-core.js";
import { checkLoginServices, collectLoginServiceSources, THIRD_PARTY_LOGIN_MARKERS } from "../src/login-services.js";

const ENTITLED = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>com.apple.developer.applesignin</key>
  <array>
    <string>Default</string>
  </array>
</dict></plist>`;

const NOT_ENTITLED = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <!-- <key>com.apple.developer.applesignin</key><array><string>Default</string></array> -->
  <key>com.apple.security.app-sandbox</key>
  <true/>
</dict></plist>`;

const GOOGLE_FIRST = `import SwiftUI
import AuthenticationServices

struct SignInView: View {
    var body: some View {
        VStack {
            Button("Continue with Google") { startGoogle() }
            SignInWithAppleButton(.signIn) { _ in } onCompletion: { _ in }
        }
    }
}`;

const APPLE_FIRST = `import SwiftUI
import AuthenticationServices

struct SignInView: View {
    var body: some View {
        VStack {
            SignInWithAppleButton(.signIn) { _ in } onCompletion: { _ in }
            Button("Continue with Google") { startGoogle() }
            Button("Delete account") { deleteAccount() }
        }
    }
}`;

const GOOGLE_ONLY = `import GoogleSignIn

struct SignInView: View {
    var body: some View {
        Button("Sign in with Google") { GIDSignIn.sharedInstance.signIn(withPresenting: root) }
    }
}`;

const NO_THIRD_PARTY = `import SwiftUI

struct SignInView: View {
    var body: some View {
        Button("Sign in") { signIn() }
    }
}`;

const COMMENTED = `import SwiftUI

// Button("Continue with Google") was removed in 1.1.
/// Sign in with GitHub used to live here.
/*
 GIDSignIn.sharedInstance.signIn(withPresenting: root)
 */
/* FBLoginButton() */ struct SignInView: View {
    var body: some View {
        Button("Sign in") { signIn() }
    }
}`;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adk-login-"));
  tempDirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

async function run(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const cli = createCli({ stdout: (chunk) => stdout.push(chunk), stderr: (chunk) => stderr.push(chunk) });
  const code = await cli(argv);
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

const rules = (files: { path: string; content: string }[]) => checkLoginServices(files).findings.map((finding) => finding.rule);

describe("checkLoginServices", () => {
  it("fails a Google button rendered before Sign in with Apple", () => {
    const report = checkLoginServices([
      { path: "SignInView.swift", content: GOOGLE_FIRST },
      { path: "App.entitlements", content: ENTITLED }
    ]);
    expect(report.applies).toBe(true);
    expect(report.findings).toEqual([
      {
        rule: "sign-in-with-apple-not-first",
        message:
          "Sign in with Apple must be first or at least as prominent: its button (line 8) comes after a third-party sign-in control (line 7).",
        path: "SignInView.swift",
        line: 7
      }
    ]);
  });

  it("passes Sign in with Apple before Google, and notes account deletion", () => {
    const report = checkLoginServices([
      { path: "SignInView.swift", content: APPLE_FIRST },
      { path: "App.entitlements", content: ENTITLED }
    ]);
    expect(report.findings).toEqual([]);
    expect(report.thirdParty).toEqual([{ provider: "Google", path: "SignInView.swift", line: 8 }]);
    expect(report.signInWithApple).toEqual([{ provider: "Apple", path: "SignInView.swift", line: 7 }]);
    expect(report.notes).toEqual([]);
  });

  it("fails Google with no Sign in with Apple", () => {
    const report = checkLoginServices([
      { path: "SignInView.swift", content: GOOGLE_ONLY },
      { path: "App.entitlements", content: ENTITLED }
    ]);
    expect(report.findings).toEqual([
      expect.objectContaining({ rule: "sign-in-with-apple-missing", path: "SignInView.swift", line: 1 })
    ]);
    expect(report.findings[0]!.message).toContain("offers Google login but no Sign in with Apple");
  });

  it("fails when no entitlements file grants Sign in with Apple", () => {
    const files = [
      { path: "SignInView.swift", content: APPLE_FIRST },
      { path: "App.entitlements", content: NOT_ENTITLED }
    ];
    expect(rules(files)).toEqual(["apple-sign-in-entitlement-missing"]);
    expect(checkLoginServices(files).findings[0]!.message).toBe(
      "No .entitlements file grants com.apple.developer.applesignin (checked App.entitlements)."
    );
  });

  it("fails when there is no entitlements file at all", () => {
    const report = checkLoginServices([{ path: "SignInView.swift", content: APPLE_FIRST }]);
    expect(report.findings.map((finding) => finding.message)).toEqual([
      "The app offers Google login but no .entitlements file was found to grant com.apple.developer.applesignin."
    ]);
  });

  it("notes an entitlements file without the key when another grants it", () => {
    const report = checkLoginServices([
      { path: "SignInView.swift", content: APPLE_FIRST },
      { path: "App.entitlements", content: ENTITLED },
      { path: "Widget.entitlements", content: NOT_ENTITLED }
    ]);
    expect(report.findings).toEqual([]);
    expect(report.notes).toEqual([
      "Widget.entitlements does not grant com.apple.developer.applesignin. Fine for an extension; every app target that shows sign-in needs it."
    ]);
  });

  it("passes an app with no third-party login", () => {
    const report = checkLoginServices([{ path: "SignInView.swift", content: NO_THIRD_PARTY }]);
    expect(report).toEqual({
      applies: false,
      thirdParty: [],
      signInWithApple: [],
      findings: [],
      notes: ["No third-party login found, so Guideline 4.8 does not apply."]
    });
  });

  it("ignores markers on comment-only lines and in block comments", () => {
    expect(checkLoginServices([{ path: "SignInView.swift", content: COMMENTED }]).applies).toBe(false);
  });

  it("orders on generic OAuth controls once a provider is offered", () => {
    const view = `struct SignInView: View {
    private static let googleOAuthSignInIdentifier = "native Google OAuth sign-in"
    var body: some View {
        ForEach(OAuthProviderHint.allCases, id: \\.self) { provider in
            Button { Task { await handleBrowserOAuthSignIn(provider: provider) } } label: { Text(provider.title) }
        }
        SignInWithAppleButton(.signIn) { _ in } onCompletion: { _ in }
    }
    private func handleBrowserOAuthSignIn(provider: OAuthProviderHint) async {}
}
extension OAuthProviderHint {
    var title: String { self == .google ? "Continue with Google" : "Continue with GitHub" }
}`;
    const report = checkLoginServices([
      { path: "SignInView.swift", content: view },
      { path: "App.entitlements", content: ENTITLED }
    ]);
    expect(report.findings).toEqual([expect.objectContaining({ rule: "sign-in-with-apple-not-first", line: 4 })]);
    expect(report.thirdParty.map((hit) => hit.provider)).toEqual(["Google", "GitHub"]);
  });

  it("does not treat generic OAuth code alone as a third-party login", () => {
    const view = `func start() { ForEach(OAuthProviderHint.allCases) { _ in }; beginOAuthSignIn() }`;
    expect(checkLoginServices([{ path: "Own.swift", content: view }]).applies).toBe(false);
  });

  it("does not judge ordering across files", () => {
    const report = checkLoginServices([
      { path: "Google.swift", content: `Button("Continue with Google") {}` },
      { path: "Apple.swift", content: "let provider = ASAuthorizationAppleIDProvider()" },
      { path: "App.entitlements", content: ENTITLED }
    ]);
    expect(report.findings).toEqual([]);
  });

  it("reports account creation without deletion", () => {
    const report = checkLoginServices([
      { path: "SignInView.swift", content: `${APPLE_FIRST.replace("Delete account", "Done").replace("deleteAccount()", "close()")}\nlet a = "Create an account"\nlet b = "Sign up"` },
      { path: "App.entitlements", content: ENTITLED }
    ]);
    expect(report.notes).toEqual([
      "Account creation found at SignInView.swift:13. Guideline 5.1.1(v): the app must also let people delete their account in the app. No account deletion found in code; check it by hand."
    ]);
  });

  it("reports account creation with deletion", () => {
    const report = checkLoginServices([
      { path: "SignUp.swift", content: `Button("Create account") {}` },
      { path: "SignInView.swift", content: APPLE_FIRST },
      { path: "More.swift", content: "Button(\"Create account\") {}\nfunc deleteAccount() {}" },
      { path: "App.entitlements", content: ENTITLED }
    ]);
    expect(report.notes).toEqual([
      "Account creation found at SignUp.swift:1. Guideline 5.1.1(v): the app must also let people delete their account in the app. Account deletion found at SignInView.swift:9."
    ]);
  });

  it("recognizes each provider in the marker list", () => {
    const samples = [
      "import GoogleSignIn",
      "GoogleSignInButton(action: signIn)",
      "import FBSDKLoginKit",
      "let button = FBLoginButton()",
      "import MSAL",
      "import Auth0",
      "let provider = OAuthProvider(providerID: \"github.com\")",
      "let credential = GoogleAuthProvider.credential(withIDToken: id, accessToken: token)",
      "let button = TWTRLogInButton { _, _ in }",
      "Text(\"Log in with Microsoft\")",
      "Text(\"Continue with X\")",
      "Text(\"Sign in with Slack\")"
    ];
    for (const sample of samples) {
      expect(checkLoginServices([{ path: "A.swift", content: sample }]).applies, sample).toBe(true);
    }
    expect(THIRD_PARTY_LOGIN_MARKERS.some((marker) => marker.provider === "Facebook")).toBe(true);
    expect(checkLoginServices([{ path: "A.swift", content: "Text(\"Continue with Xcode\")" }]).applies).toBe(false);
  });
});

describe("collectLoginServiceSources", () => {
  it("reads Swift and entitlements files, skipping build output, dependencies and tests", async () => {
    const root = await tree({
      "App/SignInView.swift": GOOGLE_FIRST,
      "App/App.entitlements": ENTITLED,
      "App/Info.plist": "<plist/>",
      ".build/checkouts/Dep.swift": GOOGLE_ONLY,
      "DerivedData/Gen.swift": GOOGLE_ONLY,
      "node_modules/x/X.swift": GOOGLE_ONLY,
      "Pods/GoogleSignIn/GIDSignIn.swift": GOOGLE_ONLY,
      ".git/hooks/H.swift": GOOGLE_ONLY,
      "Tests/AppTests/T.swift": GOOGLE_ONLY,
      "AppTests/Helper.swift": GOOGLE_ONLY,
      "App/SignInViewTests.swift": GOOGLE_ONLY,
      "App/AppUITestsLaunch.swift": GOOGLE_ONLY,
      "Sources/A.swift": NO_THIRD_PARTY
    });
    await symlink(join(root, "App"), join(root, "Linked"));
    const files = await collectLoginServiceSources(root);
    expect(files.map((file) => file.path)).toEqual(["App/App.entitlements", "App/SignInView.swift", "Sources/A.swift"]);
    expect(files[1]!.content).toBe(GOOGLE_FIRST);
  });
});

describe("review login-services CLI", () => {
  it("lists the command in the usage text", async () => {
    expect((await run(["--help"])).stdout).toContain("review login-services [--root <dir>] [--json]");
  });

  it("exits 1 and prints the ordering finding", async () => {
    const root = await tree({ "SignInView.swift": GOOGLE_FIRST, "App.entitlements": ENTITLED });
    const result = await run(["review", "login-services", "--root", root]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(
      "FAIL sign-in-with-apple-not-first: Sign in with Apple must be first or at least as prominent: its button (line 8) comes after a third-party sign-in control (line 7). (SignInView.swift:7)\n" +
        "Guideline 4.8 login services: 1 finding\n"
    );
  });

  it("prints a finding with no file location and pluralizes", async () => {
    const root = await tree({ "SignInView.swift": GOOGLE_ONLY });
    const result = await run(["review", "login-services", "--root", root]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "FAIL apple-sign-in-entitlement-missing: The app offers Google login but no .entitlements file was found to grant com.apple.developer.applesignin.\n"
    );
    expect(result.stdout).toContain("Guideline 4.8 login services: 2 findings\n");
  });

  it("exits 0 with notes when Sign in with Apple is first", async () => {
    const root = await tree({ "SignInView.swift": APPLE_FIRST, "App.entitlements": ENTITLED });
    const result = await run(["review", "login-services", "--root", root]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Guideline 4.8 login services: passed (Google login with Sign in with Apple first)\n");
  });

  it("exits 0 when 4.8 does not apply, defaulting to the working directory", async () => {
    const root = await tree({ "SignInView.swift": NO_THIRD_PARTY });
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const result = await run(["review", "login-services"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("note: No third-party login found, so Guideline 4.8 does not apply.\n");
    } finally {
      process.chdir(cwd);
    }
  });

  it("prints JSON and keeps the exit code", async () => {
    const failing = await tree({ "SignInView.swift": GOOGLE_FIRST, "App.entitlements": ENTITLED });
    const failed = await run(["review", "login-services", "--root", failing, "--json"]);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, result: { applies: true, findings: [{ rule: "sign-in-with-apple-not-first" }] } });

    const passing = await tree({ "SignInView.swift": APPLE_FIRST, "App.entitlements": ENTITLED });
    const passed = await run(["review", "login-services", "--root", passing, "--json"]);
    expect(passed.code).toBe(0);
    expect(JSON.parse(passed.stdout)).toMatchObject({ ok: true, result: { findings: [] } });
  });

  it("fails cleanly on a missing root", async () => {
    const result = await run(["review", "login-services", "--root", join(tmpdir(), "adk-login-does-not-exist")]);
    expect(result.code).toBe(66);
    expect(result.stderr).toContain("ENOENT");
  });
});

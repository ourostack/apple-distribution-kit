import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * App Store Review Guideline 4.8 (Login Services): an app that offers a third-party login must also offer
 * an equivalent private login, in practice Sign in with Apple, and App Review expects it at least as
 * prominent. Spoonjoy for Mac 1.0 was rejected under 4.8 with Sign in with Apple present but rendered
 * last, below the Google and GitHub buttons.
 */

export interface SourceFile {
  path: string;
  content: string;
}

export interface LoginMarker {
  /** Who the marker points at, for the report. */
  provider: string;
  pattern: RegExp;
  /** The marker alone shows the app offers this third-party login. */
  offers: boolean;
  /** The marker sits where a sign-in control is placed on screen; used for the ordering rule. */
  control: boolean;
}

const BUTTON_TEXT_PROVIDERS = [
  "Google",
  "GitHub",
  "Facebook",
  "Meta",
  "Microsoft",
  "X",
  "Twitter",
  "LinkedIn",
  "Amazon",
  "Discord",
  "Slack"
] as const;

function buttonText(provider: string): RegExp {
  return new RegExp(String.raw`\b(?:continue|sign[\s-]*in|sign[\s-]*up|log[\s-]*in)\s+with\s+${provider}\b`, "i");
}

/** Third-party login markers. Add a provider or SDK here; nothing else needs to change. */
export const THIRD_PARTY_LOGIN_MARKERS: readonly LoginMarker[] = [
  ...BUTTON_TEXT_PROVIDERS.map((provider) => ({ provider, pattern: buttonText(provider), offers: true, control: true })),
  { provider: "Google", pattern: /\bimport\s+GoogleSignIn\b|\bGIDSignIn\b|\bGIDConfiguration\b/, offers: true, control: false },
  { provider: "Google", pattern: /\bGIDSignInButton\b|\bGoogleSignInButton\b/, offers: true, control: true },
  { provider: "Facebook", pattern: /\bimport\s+FBSDKLoginKit\b|\bFBSDKLoginManager\b/, offers: true, control: false },
  { provider: "Facebook", pattern: /\bFBLoginButton\b|\bFBSDKLoginButton\b/, offers: true, control: true },
  // Auth0 and MSAL alone are often the app's own or an enterprise account system, which 4.8 exempts; only a social
  // connection counts.
  {
    provider: "Auth0",
    pattern: /\.connection\s*\(\s*"(?:google-oauth2|github|facebook|windowslive|twitter|linkedin)"/,
    offers: true,
    control: false
  },
  {
    provider: "Firebase",
    pattern:
      /^(?!.*"apple\.com").*?(?:\b(?:Google|Facebook|Twitter|GitHub|Microsoft|Yahoo)AuthProvider\b|\bOAuthProvider\s*(?:\(|\.provider\s*\(|\.credential\s*\())/,
    offers: true,
    control: false
  },
  { provider: "Supabase", pattern: /\bsignInWithOAuth\s*\(\s*provider:\s*\.(?!apple\b)\w+/, offers: true, control: false },
  { provider: "Amplify", pattern: /\bsignInWithWebUI\s*\(\s*for:\s*\.(?!apple\b)\w+/, offers: true, control: false },
  { provider: "Twitter", pattern: /\bTWTRLogInButton\b/, offers: true, control: true },
  // Generic OAuth sign-in controls (a ForEach over providers, a call that starts an OAuth sign-in). They do not by
  // themselves mean a third-party login, but once one is found they mark where its buttons sit.
  { provider: "OAuth", pattern: /\bOAuthProvider\w*\.allCases\b/, offers: false, control: true },
  { provider: "OAuth", pattern: /(?<!func\s)\b\w*OAuth\w*Sign(?:In|Up)\w*\s*\(/, offers: false, control: true }
];

/** Sign in with Apple markers. `control` marks the on-screen button. */
export const SIGN_IN_WITH_APPLE_MARKERS: readonly LoginMarker[] = [
  { provider: "Apple", pattern: /\bSignInWithAppleButton\b|\bASAuthorizationAppleIDButton\b/, offers: true, control: true },
  { provider: "Apple", pattern: /\bASAuthorizationAppleIDProvider\b/, offers: true, control: false }
];

export const APPLE_SIGN_IN_ENTITLEMENT = "com.apple.developer.applesignin";

const ACCOUNT_CREATION = /\bcreate\s+(?:an\s+|your\s+)?account\b|\bsign\s*up\b|\bcreateAccount\b/i;
const ACCOUNT_DELETION = /\bdelete\s+(?:my\s+|your\s+|this\s+)?account\b|\bdeleteAccount\b|\bAccountDeletion/i;

export type LoginServicesRule = "sign-in-with-apple-missing" | "apple-sign-in-entitlement-missing" | "sign-in-with-apple-not-first";

export interface LoginServicesFinding {
  rule: LoginServicesRule;
  message: string;
  path?: string;
  line?: number;
}

export interface MarkerHit {
  provider: string;
  path: string;
  line: number;
}

export interface LoginServicesReport {
  /** True when the app offers a third-party login, so Guideline 4.8 applies. */
  applies: boolean;
  thirdParty: MarkerHit[];
  signInWithApple: MarkerHit[];
  findings: LoginServicesFinding[];
  notes: string[];
  /** True when some file holds both a Sign in with Apple button and a third-party control, so their order was compared. */
  orderChecked: boolean;
}

interface CodeLine {
  line: number;
  text: string;
}

/** The code on each line of a Swift file, with comments removed (string literals are kept intact). */
function codeLines(content: string): CodeLine[] {
  const lines: CodeLine[] = [];
  let inBlock = false;
  content.split(/\r?\n/).forEach((raw, index) => {
    let code = "";
    let inString = false;
    for (let i = 0; i < raw.length; i++) {
      const char = raw.charAt(i);
      const pair = raw.slice(i, i + 2);
      if (inBlock) {
        if (pair === "*/") {
          inBlock = false;
          i++;
        }
        continue;
      }
      if (inString) {
        code += char;
        if (char === "\\") {
          code += raw.charAt(i + 1);
          i++;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (pair === "//") break;
      if (pair === "/*") {
        inBlock = true;
        i++;
        continue;
      }
      if (char === '"') inString = true;
      code += char;
    }
    const text = code.trim();
    if (text !== "") lines.push({ line: index + 1, text });
  });
  return lines;
}

interface ViewProperty {
  name: string;
  /** A view struct is used as `Name(`; a helper property or function by its bare name. */
  kind: "struct" | "member";
  start: number;
  end: number;
  /** Where uses of a member are looked for: the struct that declares it, or the whole file. */
  scope: { start: number; end: number };
}

const VIEW_STRUCT = /\bstruct\s+(\w+)\s*:[^{]*\bView\b[^{]*\{/;
const VIEW_MEMBER = /\b(?:var\s+(\w+)\s*:\s*some\s+View|func\s+(\w+)\s*\([^)]*\)\s*->\s*some\s+View)\s*\{/;

function braceDelta(text: string): number {
  const code = text.replace(/"(?:\\.|[^"\\])*"/g, '""');
  return (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
}

/**
 * Called only for a file that holds sign-in controls, so `lines` is never empty.
 * View structs (`struct Name: View { ... }`) and helper views (`var name: some View { ... }` or
 * `func name() -> some View { ... }`, not `body`) with their line spans.
 */
function viewProperties(lines: CodeLine[]): ViewProperty[] {
  const properties: ViewProperty[] = [];
  const whole = { start: lines[0]!.line, end: lines[lines.length - 1]!.line };
  lines.forEach(({ line, text }, index) => {
    const struct = VIEW_STRUCT.exec(text)?.[1];
    const member = VIEW_MEMBER.exec(text);
    const name = struct ?? member?.[1] ?? member?.[2];
    if (!name || name === "body") return;
    let depth = 0;
    let end = whole.end;
    for (const candidate of lines.slice(index)) {
      depth += braceDelta(candidate.text);
      if (depth <= 0) {
        end = candidate.line;
        break;
      }
    }
    properties.push({ name, kind: struct ? "struct" : "member", start: line, end, scope: whole });
  });
  for (const property of properties) {
    if (property.kind === "struct") continue;
    const owner = properties
      .filter((candidate) => candidate.kind === "struct" && candidate.start < property.start && property.end <= candidate.end)
      .pop();
    if (owner) property.scope = { start: owner.start, end: owner.end };
  }
  return properties;
}

/**
 * Where a control appears in the view tree, outermost first. A control inside a helper view or a view struct sits at
 * the first line that uses it, so `VStack { appleButton; GoogleRow() }` is judged by that order, not by where the
 * helpers are declared; two controls in the same helper are then ordered by their lines inside it.
 */
function anchorPath(lines: CodeLine[], properties: ViewProperty[], line: number): number[] {
  const path = [line];
  const seen = new Set<string>();
  for (;;) {
    const property = properties.filter((candidate) => candidate.start <= line && line <= candidate.end).pop();
    if (!property || seen.has(property.name)) return path;
    seen.add(property.name);
    const use = new RegExp(property.kind === "struct" ? String.raw`\b${property.name}\s*\(` : String.raw`\b${property.name}\b`);
    const reference = lines.find(
      (candidate) =>
        candidate.line >= property.scope.start &&
        candidate.line <= property.scope.end &&
        (candidate.line < property.start || candidate.line > property.end) &&
        use.test(candidate.text)
    );
    if (!reference) return path;
    line = reference.line;
    path.unshift(line);
  }
}

/** Compare two anchor paths in view-tree order. */
function comparePaths(a: number[], b: number[]): number {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

interface FileHits {
  path: string;
  lines: CodeLine[];
  thirdParty: (MarkerHit & LoginMarker)[];
  apple: (MarkerHit & LoginMarker)[];
}

function scan(path: string, lines: CodeLine[], markers: readonly LoginMarker[]): (MarkerHit & LoginMarker)[] {
  const hits: (MarkerHit & LoginMarker)[] = [];
  for (const { line, text } of lines) {
    for (const marker of markers) {
      if (marker.pattern.test(text)) hits.push({ ...marker, path, line });
    }
  }
  return hits;
}

function firstLine(lines: CodeLine[], pattern: RegExp): number | undefined {
  return lines.find(({ text }) => pattern.test(text))?.line;
}

function hasAppleSignInEntitlement(content: string): boolean {
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, "");
  return /<key>\s*com\.apple\.developer\.applesignin\s*<\/key>\s*<array>\s*<string>/.test(withoutComments);
}

function at(hit: { path: string; line: number }): string {
  return `${hit.path}:${hit.line}`;
}

/**
 * Check Swift sources and .entitlements files against Guideline 4.8. Pure: pass the files in, get findings out.
 */
export function checkLoginServices(files: SourceFile[]): LoginServicesReport {
  const entitlements = files.filter((file) => file.path.endsWith(".entitlements"));
  const swift = files.filter((file) => !file.path.endsWith(".entitlements"));
  const perFile: FileHits[] = [];
  let creation: { path: string; line: number } | undefined;
  let deletion: { path: string; line: number } | undefined;

  for (const file of swift) {
    const lines = codeLines(file.content);
    perFile.push({
      path: file.path,
      lines,
      thirdParty: scan(file.path, lines, THIRD_PARTY_LOGIN_MARKERS),
      apple: scan(file.path, lines, SIGN_IN_WITH_APPLE_MARKERS)
    });
    const created = firstLine(lines, ACCOUNT_CREATION);
    if (!creation && created !== undefined) creation = { path: file.path, line: created };
    const deleted = firstLine(lines, ACCOUNT_DELETION);
    if (!deletion && deleted !== undefined) deletion = { path: file.path, line: deleted };
  }

  const offering = perFile.flatMap((file) => file.thirdParty.filter((hit) => hit.offers));
  const seen = new Set<string>();
  const thirdParty = offering
    .filter((hit) => {
      const key = `${hit.provider}\u0000${hit.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ provider, path, line }) => ({ provider, path, line }));
  const signInWithApple = perFile.flatMap((file) => file.apple).map(({ provider, path, line }) => ({ provider, path, line }));
  const findings: LoginServicesFinding[] = [];
  const notes: string[] = [];

  if (thirdParty.length === 0) {
    notes.push("No third-party login found, so Guideline 4.8 does not apply.");
    return { applies: false, thirdParty, signInWithApple, findings, notes, orderChecked: false };
  }

  const providers = [...new Set(thirdParty.map((hit) => hit.provider))].join(", ");
  if (signInWithApple.length === 0) {
    findings.push({
      rule: "sign-in-with-apple-missing",
      message: `The app offers ${providers} login but no Sign in with Apple (SignInWithAppleButton, ASAuthorizationAppleIDButton or ASAuthorizationAppleIDProvider).`,
      path: thirdParty[0]!.path,
      line: thirdParty[0]!.line
    });
  }

  const granted = entitlements.filter((file) => hasAppleSignInEntitlement(file.content));
  if (granted.length === 0) {
    findings.push({
      rule: "apple-sign-in-entitlement-missing",
      message:
        entitlements.length === 0
          ? `The app offers ${providers} login but no .entitlements file was found to grant ${APPLE_SIGN_IN_ENTITLEMENT}.`
          : `No .entitlements file grants ${APPLE_SIGN_IN_ENTITLEMENT} (checked ${entitlements.map((file) => file.path).join(", ")}).`
    });
  } else {
    for (const file of entitlements.filter((candidate) => !granted.includes(candidate))) {
      notes.push(
        `${file.path} does not grant ${APPLE_SIGN_IN_ENTITLEMENT}. Fine for an extension; every app target that shows sign-in needs it.`
      );
    }
  }

  let orderChecked = false;
  for (const file of perFile) {
    if (!file.thirdParty.some((hit) => hit.control) || !file.apple.some((hit) => hit.control)) continue;
    const properties = viewProperties(file.lines);
    const first = (hits: (MarkerHit & LoginMarker)[]) =>
      hits
        .filter((hit) => hit.control)
        .map((hit) => ({ line: hit.line, path: anchorPath(file.lines, properties, hit.line) }))
        .sort((a, b) => comparePaths(a.path, b.path))[0]!;
    const thirdPartyControl = first(file.thirdParty);
    const appleControl = first(file.apple);
    orderChecked = true;
    if (comparePaths(appleControl.path, thirdPartyControl.path) < 0) continue;
    findings.push({
      rule: "sign-in-with-apple-not-first",
      message: `Sign in with Apple must be first or at least as prominent: its button (line ${appleControl.line}) is placed after a third-party sign-in control (line ${thirdPartyControl.line}).`,
      path: file.path,
      line: thirdPartyControl.line
    });
  }

  if (creation) {
    notes.push(
      `Account creation found at ${at(creation)}. Guideline 5.1.1(v): the app must also let people delete their account in the app. ${
        deletion ? `Account deletion found at ${at(deletion)}.` : "No account deletion found in code; check it by hand."
      }`
    );
  }

  return { applies: true, thirdParty, signInWithApple, findings, notes, orderChecked };
}

const SKIPPED_DIRECTORIES = new Set([".build", "DerivedData", "node_modules", "Pods", ".git", "Carthage", "SourcePackages", ".swiftpm", "vendor"]);

function isSkippedDirectory(name: string): boolean {
  return SKIPPED_DIRECTORIES.has(name) || name.endsWith("Tests");
}

function isCheckedFile(name: string): boolean {
  if (name.endsWith(".entitlements")) return true;
  return name.endsWith(".swift") && !name.endsWith("Tests.swift") && !name.includes("UITests");
}

/** Read every .swift and .entitlements file under root, skipping build output, dependencies and tests. */
export async function collectLoginServiceSources(root: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => Number(a.name > b.name) - Number(a.name < b.name));
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!isSkippedDirectory(entry.name)) await walk(full);
      } else if (entry.isFile() && isCheckedFile(entry.name)) {
        files.push({ path: relative(root, full).split(sep).join("/"), content: await readFile(full, "utf8") });
      }
    }
  }
  await walk(root);
  return files;
}

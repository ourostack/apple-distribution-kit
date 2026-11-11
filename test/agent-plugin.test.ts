import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const plugin = join(__dirname, "..", "plugins", "apple-distribution");

const signingNeedles = [
  "apple-distribution-kit",
  "distribution/apple-distribution.json",
  "scripts/apple-distribution-kit.sh",
  "bot.ouro.md",
  "bot.ouro.workbench",
  "app.spoonjoy",
  "APP_STORE_CONNECT_API_KEY_ID",
  "APP_STORE_CONNECT_PROVIDER_PUBLIC_ID",
  "TestFlight Submission Lane",
  "testflight plan",
  "testflight publish",
  "asc get",
  "developer session import",
  "developer status",
  "developer keys list",
  "developer keys get",
  "developer services get",
  "developer services plan",
  "developer services apply",
  "developer services reconcile",
  "signing profiles",
  "resultCode",
  "2100",
  "ExportOptions.testflight.plist",
  "method = app-store-connect",
  "Stop for the operator for:",
  "not source files",
  "non-secret CI/preflight gate",
  "Use app-neutral names for reusable materials",
  "For non-Ouro apps, rename these env vars",
];

describe("apple-distribution agent plugin", () => {
  it("declares its skills folder in both manifests, with matching names and versions", () => {
    const copilot = JSON.parse(readFileSync(join(plugin, "plugin.json"), "utf8"));
    const claude = JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
    expect(copilot.skills).toBe("./skills/");
    expect(claude.skills).toBe("./skills/");
    expect(claude.name).toBe(copilot.name);
    expect(claude.version).toBe(copilot.version);
  });

  it("ships each skill with a SKILL.md whose name matches its folder", () => {
    const skills = readdirSync(join(plugin, "skills")).sort();
    expect(skills).toEqual(["build-native-apple-app", "mac-app-distribution", "sign-apple-apps"]);
    for (const skill of skills) {
      const file = join(plugin, "skills", skill, "SKILL.md");
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: \\S`, "u"));
    }
  });

  it("keeps the kit's signing guidance in sign-apple-apps", () => {
    const skill = readFileSync(join(plugin, "skills", "sign-apple-apps", "SKILL.md"), "utf8");
    expect(signingNeedles.filter((needle) => !skill.includes(needle))).toEqual([]);
  });
});

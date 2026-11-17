import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendored = join(root, "tools", "ouro-actions");
const manifest = JSON.parse(readFileSync(join(vendored, "dist-manifest.json"), "utf8")) as { coreTag: string; files: Record<string, string> };
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("vendored ouro-actions generator", () => {
  it("is the generator and claim set of the ouro-ui-core release its manifest names, by hash", () => {
    expect(manifest.coreTag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(sha256(join(vendored, "ouro-actions.mts"))).toBe(manifest.files["dist/actions/ouro-actions.mts"]);
    expect(sha256(join(vendored, "actions.claims.json"))).toBe(manifest.files["dist/ax/actions.claims.json"]);
  });

  it("has committed projections that match the declarations", () => {
    const result = spawnSync(
      process.execPath,
      [join(vendored, "ouro-actions.mts"), "check", join(root, "actions", "apple-distribution-kit.actions.mts"), join(root, "actions", "generated")],
      { encoding: "utf8" }
    );
    expect(result.stderr + result.stdout).toContain("every projection matches its declaration");
    expect(result.status).toBe(0);
  });
});

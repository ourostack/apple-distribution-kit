import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "src/ouro-ax");
const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as { exclude?: string[] };

// Ouro AX's Node-only tools (X-ray, flows, surfaces) import its shared files as `#ouro-ax/x.ts`, which tsc cannot
// rewrite when it emits (TS2877). Node runs them from source, so the build leaves out each file that brings them in.
const importsPackage = (name: string) => /["']#ouro-ax\//.test(readFileSync(join(dir, name), "utf8"));
const relativeImports = (name: string) =>
  [...readFileSync(join(dir, name), "utf8").matchAll(/(?:\bfrom\s*|\bimport\s+)["']\.\/([^"']+)["']/g)].map((match) => match[1]!);

describe("tsconfig.json", () => {
  it("leaves out the vendored Ouro AX files that import #ouro-ax, and the entry points that bring them in", () => {
    const names = readdirSync(dir).filter((name) => /\.m?ts$/.test(name));
    const reaches = (name: string, seen = new Set<string>()): boolean => {
      if (seen.has(name)) return false;
      seen.add(name);
      return importsPackage(name) || relativeImports(name).some((next) => names.includes(next) && reaches(next, seen));
    };
    const entries = names.filter((name) => name.endsWith(".ts") && reaches(name)).map((name) => `src/ouro-ax/${name}`);
    for (const entry of entries) expect(tsconfig.exclude ?? [], entry).toContain(entry);
  });
});

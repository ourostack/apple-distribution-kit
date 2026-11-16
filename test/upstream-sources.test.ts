import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type LockFile = {
  schemaVersion: number;
  sources: { id: string; repository: string; commit: string; license: string; files: { sourcePath: string; generatedPath: string; sha256: string }[] }[];
};

const lock = JSON.parse(readFileSync(join(root, "upstream-sources.lock.json"), "utf8")) as LockFile;

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("upstream-sources.lock.json", () => {
  it("pins the Ouro AX kit at a full commit sha, under MIT", () => {
    expect(lock.schemaVersion).toBe(1);
    const [source] = lock.sources;
    expect(source?.id).toBe("ourostack-ouro-ui-ax");
    expect(source?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(source?.license).toBe("MIT");
  });

  it("matches every vendored file's sha256", () => {
    for (const source of lock.sources) {
      for (const file of source.files) {
        const path = join(root, file.generatedPath);
        expect(existsSync(path), file.generatedPath).toBe(true);
        expect(sha256(path), file.generatedPath).toBe(file.sha256);
      }
    }
  });

  it("lists every file vendored under src/ouro-ax, so none is copied in by hand", () => {
    const dir = join(root, "src/ouro-ax");
    const onDisk = readdirSync(dir).filter((name) => name.endsWith(".ts")).map((name) => `src/ouro-ax/${name}`).sort();
    const listed = lock.sources.flatMap((source) => source.files.map((file) => file.generatedPath)).filter((path) => path.startsWith("src/ouro-ax/") && path.endsWith(".ts")).sort();
    expect(listed).toEqual(onDisk);
  });
});

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("CI workflow", () => {
  it("audits the frozen dependency tree before build and coverage", async () => {
    const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const install = workflow.indexOf("- run: npm ci");
    const audit = workflow.indexOf("- run: npm audit --audit-level=moderate");
    const build = workflow.indexOf("- run: npm run build");
    const coverage = workflow.indexOf("- run: npm run coverage");

    expect([...workflow.matchAll(/- run: npm audit --audit-level=moderate/g)]).toHaveLength(1);
    expect(install).toBeGreaterThan(-1);
    expect(audit).toBeGreaterThan(install);
    expect(build).toBeGreaterThan(audit);
    expect(coverage).toBeGreaterThan(build);
  });
});

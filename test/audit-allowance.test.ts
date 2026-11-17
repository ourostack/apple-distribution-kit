import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)
const ROOT = join(import.meta.dirname, "..")
const { checkAudit, runAudit } = require(join(ROOT, "scripts/audit-allowance.cjs"))

const URL = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf"
const audit = (severity = "high", name = "picomatch") => ({
  vulnerabilities: {
    [name]: { via: [{ name, severity, url: URL }] },
    tinyglobby: { via: [name] },
  },
})
const lock = (version = "4.0.7") => ({ packages: { "": {}, "node_modules/picomatch": { version } } })
const entry = (extra = {}) => ({
  id: "GHSA-fc5q-39xc-vjpf", url: URL, packageName: "picomatch", version: "4.0.7", reason: "No fixed version.", expiresOn: "2026-12-17", ...extra,
})

describe("npm audit with time-boxed allowances", () => {
  it("passes an allowed advisory for its package and version until the day it expires, and fails it after", () => {
    expect(checkAudit({ audit: audit(), allowance: { allowed: [entry()] }, lock: lock(), today: "2026-12-17" })).toEqual({
      ok: true, errors: [], allowed: ["picomatch@4.0.7: GHSA-fc5q-39xc-vjpf (high) allowed until 2026-12-17"],
    })
    const expired = checkAudit({ audit: audit(), allowance: { allowed: [entry()] }, lock: lock(), today: "2026-12-18" })
    expect(expired.ok).toBe(false)
    expect(expired.errors).toContain(`audit-allowance.json: GHSA-fc5q-39xc-vjpf for picomatch expired on 2026-12-17; check ${URL} for a fix, then upgrade or renew it`)
    expect(expired.errors).toContain(`picomatch@4.0.7: GHSA-fc5q-39xc-vjpf (high) ${URL}`)
  })

  it("fails an advisory with no allowance, or one for another version or package, and ignores a low one", () => {
    expect(checkAudit({ audit: audit(), allowance: undefined, lock: lock(), today: "2026-11-17" }).ok).toBe(false)
    expect(checkAudit({ audit: audit(), allowance: { allowed: [entry()] }, lock: lock("4.0.8"), today: "2026-11-17" }).errors)
      .toEqual([`picomatch@4.0.8: GHSA-fc5q-39xc-vjpf (high) ${URL}`])
    expect(checkAudit({ audit: audit("high", "micromatch"), allowance: { allowed: [entry()] }, lock: lock(), today: "2026-11-17" }).ok).toBe(false)
    expect(checkAudit({ audit: audit("low"), allowance: undefined, lock: lock(), today: "2026-11-17" })).toEqual({ ok: true, errors: [], allowed: [] })
  })

  it("fails an allowance without its link, reason or date, or a file without a list", () => {
    for (const field of ["url", "reason", "expiresOn"]) {
      const result = checkAudit({ audit: { vulnerabilities: {} }, allowance: { allowed: [entry({ [field]: "" })] }, lock: lock(), today: "2026-11-17" })
      expect(result.errors).toEqual([`audit-allowance.json: an allowance is missing ${field}`])
    }
    expect(checkAudit({ audit: { vulnerabilities: {} }, allowance: { allowed: [entry({ expiresOn: "soon" })] }, lock: lock(), today: "2026-11-17" }).ok).toBe(false)
    expect(checkAudit({ audit: { vulnerabilities: {} }, allowance: {}, lock: lock(), today: "2026-11-17" }).ok).toBe(false)
  })

  it("reads npm audit's JSON from a failing run, and fails when there is none", () => {
    const failing = () => { throw Object.assign(new Error("exit 1"), { stdout: Buffer.from(JSON.stringify(audit())) }) }
    expect(runAudit({ root: ROOT, execSyncImpl: failing, today: "2026-11-17" }).ok).toBe(true)
    expect(runAudit({ root: ROOT, execSyncImpl: () => "not json", today: "2026-11-17" }).ok).toBe(false)
    expect(runAudit({ root: ROOT, execSyncImpl: () => JSON.stringify({ error: { summary: "offline" } }), today: "2026-11-17" }).errors)
      .toEqual(["npm audit failed: offline"])
  })

  it("allows only picomatch's unfixed ReDoS, with a date and the advisory's link", () => {
    const file = JSON.parse(readFileSync(join(ROOT, "audit-allowance.json"), "utf-8"))
    expect(file.allowed.map((e: { id: string; packageName: string; url: string }) => `${e.id} ${e.packageName} ${e.url}`)).toEqual([`GHSA-fc5q-39xc-vjpf picomatch ${URL}`])
  })
})

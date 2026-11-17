#!/usr/bin/env node
// npm audit, with time-boxed allowances for advisories that have no fixed version yet.
//
//   node scripts/audit-allowance.cjs
//
// Runs `npm audit --json` and fails on any moderate-or-higher advisory, unless
// audit-allowance.json allows that advisory for that package at the version the
// lockfile installs. Each allowance names the advisory and its link, the package and
// version, why it is safe to wait, and the day it expires. An expired or incomplete
// allowance fails, so each one comes up for review again.
"use strict"

const { execSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

const GATED = new Set(["moderate", "high", "critical"])
const FIELDS = ["id", "url", "packageName", "version", "reason", "expiresOn"]

function advisoryId(url) {
  return String(url ?? "").split("/").pop()
}

function installedVersions(lock, name) {
  return [...new Set(Object.entries(lock?.packages ?? {})
    .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
    .map(([, value]) => value.version))]
}

// `today` is a YYYY-MM-DD string; an allowance is good through its expiresOn day.
function checkAudit({ audit, allowance, lock, today }) {
  const errors = []
  const allowed = []
  const entries = Array.isArray(allowance?.allowed) ? allowance.allowed : []
  if (allowance !== undefined && !Array.isArray(allowance?.allowed)) errors.push("audit-allowance.json: `allowed` is not a list")
  for (const entry of entries) {
    const missing = FIELDS.filter((field) => typeof entry?.[field] !== "string" || entry[field].trim() === "")
    if (missing.length) errors.push(`audit-allowance.json: an allowance is missing ${missing.join(", ")}`)
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expiresOn)) errors.push(`audit-allowance.json: ${entry.id} expiresOn is not a YYYY-MM-DD date`)
    else if (entry.expiresOn < today) errors.push(`audit-allowance.json: ${entry.id} for ${entry.packageName} expired on ${entry.expiresOn}; check ${entry.url} for a fix, then upgrade or renew it`)
  }
  const good = entries.filter((entry) => FIELDS.every((field) => typeof entry?.[field] === "string") && /^\d{4}-\d{2}-\d{2}$/.test(entry.expiresOn) && entry.expiresOn >= today)
  const seen = new Set()
  for (const vulnerability of Object.values(audit?.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== "object" || !GATED.has(via.severity)) continue
      const id = advisoryId(via.url)
      const key = `${via.name} ${id}`
      if (seen.has(key)) continue
      seen.add(key)
      const versions = installedVersions(lock, via.name)
      const entry = good.find((e) => e.id === id && e.packageName === via.name && versions.length > 0 && versions.every((v) => v === e.version))
      if (entry) allowed.push(`${via.name}@${entry.version}: ${id} (${via.severity}) allowed until ${entry.expiresOn}`)
      else errors.push(`${via.name}@${versions.join(", ") || "?"}: ${id} (${via.severity}) ${via.url}`)
    }
  }
  return { ok: errors.length === 0, errors, allowed }
}

function runAudit({ root = path.resolve(__dirname, ".."), execSyncImpl = execSync, today = new Date().toISOString().slice(0, 10) } = {}) {
  let output
  try {
    output = execSyncImpl("npm audit --json", { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
  } catch (error) {
    // npm audit exits non-zero when it finds anything; its JSON is still on stdout.
    output = typeof error?.stdout?.toString === "function" ? error.stdout.toString() : ""
  }
  let audit
  try { audit = JSON.parse(String(output)) } catch { return { ok: false, errors: ["npm audit --json printed no JSON; run it to see why"], allowed: [] } }
  if (audit.error) return { ok: false, errors: [`npm audit failed: ${audit.error.summary ?? audit.error.code ?? "unknown error"}`], allowed: [] }
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf-8"))
  const allowance = fs.existsSync(path.join(root, "audit-allowance.json")) ? read("audit-allowance.json") : undefined
  return checkAudit({ audit, allowance, lock: read("package-lock.json"), today })
}

if (require.main === module) {
  const result = runAudit()
  for (const line of result.allowed) console.log(`allowed: ${line}`)
  for (const line of result.errors) console.error(`audit: ${line}`)
  console.log(result.ok ? "npm audit: pass" : "npm audit: fail")
  process.exitCode = result.ok ? 0 : 1
}

module.exports = { checkAudit, runAudit }

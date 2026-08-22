# Goal

Restore the pinned `apple-distribution-kit` as a clean TestFlight prerequisite by removing the current high-severity npm advisories without changing distribution behavior.

# Scope

## In Scope

- Reproduce the `brace-expansion`, `nanoid`, and `postcss` audit failures at pinned source `4f3dd7bee99bae5b8e6807b5e0c94ed01cda52eb`.
- Apply the smallest compatible dependency/lockfile refresh that makes `npm audit --audit-level=moderate` pass.
- Run frozen install, audit, typecheck, tests, coverage, build, and deterministic `dist` checksum verification.
- Open, review, merge, and report the exact merged SHA and expected checksum for downstream pinning.

## Out of Scope

- Any change to Spoonjoy repositories or their TestFlight workflow pin.
- Feature or CLI behavior changes.
- Audit bypasses, allowlists, or severity suppression.

# Completion Criteria

- `npm ci --loglevel=error` succeeds from the committed lockfile.
- `npm audit --audit-level=moderate` reports zero vulnerabilities.
- Typecheck, full tests, coverage, and build pass.
- Two clean builds produce the same aggregate `dist` SHA-256.
- A cold reviewer finds no blocker, major, or actionable minor issue.
- The focused PR passes CI and merges; its exact merge SHA and checksum are reported.

# Code Coverage Requirements

No product code is expected to change. Existing coverage must remain green; any source change would require tests and full coverage.

# Open Questions

None. The failing packages all advertise compatible audit fixes, so lockfile-only repair is preferred unless evidence requires a manifest change.

# Decisions Made

- Preserve the package manifest and runtime behavior if `npm audit fix --package-lock-only` resolves all advisories.
- Do not use `--force`, overrides, audit allowlists, or ignored findings.
- Treat the aggregate checksum command in Spoonjoy's workflow as the downstream contract.

# Context / References

- Spoonjoy TestFlight pins repository `ourostack/apple-distribution-kit` at `4f3dd7bee99bae5b8e6807b5e0c94ed01cda52eb` and checksum `9f64507b03a5dc76a6ebc52f88cddf71f9448a8e532e4758951d2d31309d5a45`.
- Failed run: `https://github.com/spoonjoy/spoonjoy-apple/actions/runs/32571983215`.
- Baseline audit: three high findings in `brace-expansion`, `nanoid`, and `postcss`.

# Notes

Dedicated worktree: `~/Projects/apple-distribution-kit-audit-refresh`; branch: `worker/apple-distribution-audit-refresh`.

# Progress Log

- 2026-08-22 05:08 Reproduced the exact three-high audit failure and drafted the minimal repair plan.

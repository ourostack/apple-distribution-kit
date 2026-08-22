# Planning: Dependency Audit Refresh

**Status**: approved
**Created**: 2026-08-22 05:09

## Goal

Restore the pinned `apple-distribution-kit` as a clean TestFlight prerequisite by removing the current high-severity npm advisories without changing distribution behavior.

## Upstream Work Items

- None

## Scope

### In Scope

- Reproduce the `brace-expansion`, `nanoid`, and `postcss` audit failures at pinned source `4f3dd7bee99bae5b8e6807b5e0c94ed01cda52eb`.
- Apply the smallest compatible dependency/lockfile refresh that makes `npm audit --audit-level=moderate` pass.
- Add the same audit command to repository CI immediately after frozen install.
- Run frozen install, audit, typecheck, tests, coverage, build, and deterministic `dist` checksum verification.
- Open, review, merge, and report the exact merged SHA and expected checksum for downstream pinning.

### Out of Scope

- Any change to Spoonjoy repositories or their TestFlight workflow pin.
- Feature or CLI behavior changes.
- Audit bypasses, allowlists, or severity suppression.

## Completion Criteria

- [ ] `npm ci --loglevel=error` succeeds from the committed lockfile.
- [ ] `npm audit --audit-level=moderate` reports zero vulnerabilities.
- [ ] Typecheck, full tests, coverage, and build pass with 100% coverage and no warnings.
- [ ] Two independently clean builds using Spoonjoy's exact aggregate checksum command match each other and the current contract checksum `9f64507b03a5dc76a6ebc52f88cddf71f9448a8e532e4758951d2d31309d5a45`. A checksum change is allowed only as an explicit reviewed exception backed by a byte-level `dist` diff and rationale.
- [ ] `package.json` remains byte-identical, and every lockfile change maps to one of the three vulnerable dependency paths with no unrelated churn.
- [ ] A cold reviewer finds no blocker, major, or actionable minor issue.
- [ ] The focused PR passes CI and merges; its exact merge SHA and checksum are reported.
- [ ] 100% test coverage on all new code.
- [ ] All tests pass.
- [ ] No warnings.
- [ ] Visual QA is not applicable because no UI, rendering, or layout changes are in scope.

## Code Coverage Requirements

**MANDATORY: 100% coverage on all new code.**
- No `[ExcludeFromCodeCoverage]` or equivalent on new code.
- All branches covered (if/else, switch, try/catch).
- All error paths tested.
- Edge cases: null, empty, boundary values.
- No product code is expected to change; existing coverage must remain green.

## Open Questions

None. The failing packages all advertise compatible audit fixes, so lockfile-only repair is preferred unless evidence requires a manifest change.

## Decisions Made

- Preserve the package manifest and runtime behavior if `npm audit fix --package-lock-only` resolves all advisories.
- Reject broad lockfile updater output: review every changed package/version and retain only changes required along the vulnerable `brace-expansion`, `nanoid`, and `postcss` paths.
- Do not use `--force`, overrides, audit allowlists, or ignored findings.
- Treat the aggregate checksum command in Spoonjoy's workflow as the downstream contract.
- Enforce `npm audit --audit-level=moderate` in `.github/workflows/ci.yml` after `npm ci` so the repaired prerequisite cannot immediately regress.

## Context / References

- Spoonjoy TestFlight pins repository `ourostack/apple-distribution-kit` at `4f3dd7bee99bae5b8e6807b5e0c94ed01cda52eb` and checksum `9f64507b03a5dc76a6ebc52f88cddf71f9448a8e532e4758951d2d31309d5a45`.
- Failed run: `https://github.com/spoonjoy/spoonjoy-apple/actions/runs/32571983215`.
- Baseline audit: three high findings in `brace-expansion`, `nanoid`, and `postcss`.

## Notes

Dedicated worktree: `~/Projects/apple-distribution-kit-audit-refresh`; branch: `worker/apple-distribution-audit-refresh`.

## Progress Log

- 2026-08-22 05:09 Reproduced the exact three-high audit failure and drafted the minimal repair plan.
- 2026-08-22 05:11 Addressed cold-review findings by pinning byte-identical distribution output, bounded lockfile evidence, and repository CI audit enforcement.
- 2026-08-22 05:13 Planning review converged; normalized the document to the required template and marked it approved.
- 2026-08-22 05:21 Quality review corrected initial-commit metadata and restored explicit template criteria.

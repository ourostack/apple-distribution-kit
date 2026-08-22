# Doing: Dependency Audit Refresh

**Status**: drafting
**Execution Mode**: direct
**Created**: 2026-08-22 05:08
**Planning**: ./2026-08-22-0508-planning-dependency-audit-refresh.md
**Artifacts**: ./2026-08-22-0508-doing-dependency-audit-refresh/

## Execution Mode

- **pending**: Awaiting user approval before each unit starts only when the user explicitly requested interactive per-unit approval; otherwise convert this to `spawn` or `direct` unless a hard exception is present
- **spawn**: Spawn sub-agent for each unit (parallel/autonomous)
- **direct**: Execute units sequentially in current session (default)

## Objective

Restore the pinned `apple-distribution-kit` as a clean TestFlight prerequisite by removing the current high-severity npm advisories without changing distribution behavior.

## Upstream Work Items

- None

## Completion Criteria

- [ ] `npm ci --loglevel=error` succeeds from the committed lockfile.
- [ ] `npm audit --audit-level=moderate` reports zero vulnerabilities.
- [ ] Typecheck, full tests, coverage, and build pass with 100% coverage and no warnings.
- [ ] Two independently clean builds using Spoonjoy's exact aggregate checksum command match each other and the current contract checksum `9f64507b03a5dc76a6ebc52f88cddf71f9448a8e532e4758951d2d31309d5a45`. A checksum change is allowed only as an explicit reviewed exception backed by a byte-level `dist` diff and rationale.
- [ ] `package.json` remains byte-identical, and every lockfile change maps to one of the three vulnerable dependency paths with no unrelated churn.
- [ ] A cold reviewer finds no blocker, major, or actionable minor issue.
- [ ] The focused PR passes CI and merges; its exact merge SHA and checksum are reported.

## Code Coverage Requirements

**MANDATORY: 100% coverage on all new code.**
- No coverage exclusions on new code.
- All branches and error paths covered.
- No product code is expected to change; existing coverage must remain green.

## TDD Requirements

**Strict TDD — no exceptions:**
1. **Tests first**: Write failing tests BEFORE any implementation
2. **Verify failure**: Run tests, confirm they FAIL (red)
3. **Minimal implementation**: Write just enough code to pass
4. **Verify pass**: Run tests, confirm they PASS (green)
5. **Refactor**: Clean up, keep tests green
6. **No skipping**: Never write implementation without failing test first

## Work Units

### Legend
⬜ Not started · 🔄 In progress · ✅ Done · ❌ Blocked

### ⬜ Unit 0: Capture Baseline and Safety Invariants
**What**: Record the pinned commit, `package.json` SHA-256, current lockfile dependency paths for `brace-expansion`, `nanoid`, and `postcss`, failing audit JSON, and current `dist` contract checksum in the artifacts directory. Confirm the worktree is clean except for task documents before implementation.
**Output**: Baseline evidence files under `./2026-08-22-0508-doing-dependency-audit-refresh/`.
**Acceptance**: Evidence reproduces exactly three high advisories, identifies every affected lockfile path, and records `package.json` and expected checksum invariants.

### ⬜ Unit 1a: CI Audit Gate — Test
**What**: Add `test/ci-workflow.test.ts` that reads `.github/workflows/ci.yml` and asserts exactly one `npm audit --audit-level=moderate` command occurs after `npm ci` and before build/coverage commands.
**Output**: A focused workflow contract test and saved red test output.
**Acceptance**: The focused test exists and fails against the current workflow for the missing audit command.

### ⬜ Unit 1b: CI Audit Gate — Implementation
**What**: Add `- run: npm audit --audit-level=moderate` immediately after `- run: npm ci` in `.github/workflows/ci.yml`.
**Output**: The minimal workflow change and saved green focused-test output.
**Acceptance**: The focused test and full test suite pass with no warnings; no unrelated workflow behavior changes.

### ⬜ Unit 1c: CI Audit Gate — Coverage and Refactor
**What**: Run coverage, confirm the new test introduces no uncovered executable code, and simplify only if needed while keeping the assertion exact.
**Output**: Coverage output demonstrating the repository remains at 100% and a final focused test file.
**Acceptance**: Existing coverage thresholds remain at 100%, the full suite stays green, and the CI contract test remains readable and deterministic.

### ⬜ Unit 2a: Dependency Repair — Failing Contract
**What**: Verify Unit 0's immutable baseline audit and dependency-tree artifacts correspond to the pinned source and explicitly treat their non-zero audit result as the red dependency contract.
**Output**: A dependency-repair red-contract note referencing the exact Unit 0 artifacts and pinned commit.
**Acceptance**: The referenced evidence fails specifically on the three known high advisories and identifies every vulnerable path.

### ⬜ Unit 2b: Dependency Repair — Minimal Lockfile Update
**What**: Run `npm audit fix --package-lock-only --ignore-scripts --loglevel=error`. Accept only these lock entries and associated `resolved`, `integrity`, `engines`, or dependency-metadata fields: root `brace-expansion` `5.0.7 → 5.0.9`, nested `glob/node_modules/brace-expansion` `2.1.1 → 2.1.4`, `nanoid` `3.3.15 → 3.3.18`, and `postcss` `8.5.16 → 8.5.26`. If the command changes any other package entry or `package.json`, revert the generated lockfile and stop for redesign; there is no broader fallback command.
**Output**: A focused `package-lock.json` diff and a lockfile-delta mapping artifact.
**Acceptance**: `npm ci --loglevel=error` succeeds, `npm audit --audit-level=moderate` exits zero, `package.json` SHA-256 is unchanged, and an artifact maps every lockfile delta to a known advisory path.

### ⬜ Unit 2c: Dependency Repair — Verification
**What**: Run `npm ls brace-expansion nanoid postcss`, typecheck, tests, and coverage from the repaired frozen install; save audit and dependency-tree evidence.
**Output**: Post-repair audit, dependency-tree, typecheck, test, and coverage logs.
**Acceptance**: All commands pass, no vulnerable version remains in the installed tree, all tests pass, and coverage remains 100% with no warnings.

### ⬜ Unit 3a: Candidate Validation
**What**: From the candidate worktree, run `npm ci --loglevel=error`, `npm audit --audit-level=moderate`, `npm run typecheck`, `npm test`, `npm run coverage`, and `npm run build`.
**Output**: A candidate validation log covering every required command.
**Acceptance**: The frozen install and every audit, static-analysis, test, coverage, and build command pass with no warnings.

### ⬜ Unit 3b: Independent Distribution Verification
**What**: After all implementation, validation, and task-document working commits, remove the task documents from the final product diff, commit that removal, and record that commit as `CANDIDATE_SHA`. Create two detached disposable worktrees with `git worktree add --detach <temp-path> "$CANDIDATE_SHA"`; in each repeat frozen install, audit, and build. Compute `find dist -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}'`, compare file lists, then remove each with `git worktree remove <temp-path>`.
**Output**: Two clean-build logs, file lists, and checksums in the artifacts directory.
**Acceptance**: Both builds pass; checksums equal one another and `9f64507b03a5dc76a6ebc52f88cddf71f9448a8e532e4758951d2d31309d5a45`. If not, stop and produce a byte-level `dist` diff for reviewer disposition.

### ⬜ Unit 4a: Cold Review and Remediation
**What**: Request a fresh cold review of the complete diff and validation artifacts that explicitly names `CANDIDATE_SHA`. If remediation is required, commit it, designate the new head as `CANDIDATE_SHA`, rerun Units 3a–3b, and request another fresh review. Repeat until a reviewer converges on the final unchanged head.
**Output**: A converged cold-review verdict for the exact candidate head.
**Acceptance**: The reviewer reports no blocker, major, or actionable minor finding and all validation remains green after remediation.

### ⬜ Unit 4b: Pull Request and CI
**What**: Push the final atomic commits and open a pull request titled `Fix audited transitive dependencies`. Its body must list the four exact lockfile version changes, the CI audit gate, full local validation, and the unchanged distribution checksum. Confirm the final diff contains only `.github/workflows/ci.yml`, `package-lock.json`, and `test/ci-workflow.test.ts`; task documents and local artifacts must not be present. Monitor required CI on the reviewed `CANDIDATE_SHA` to completion.
**Output**: A focused pull request whose required checks pass on the reviewed head SHA.
**Acceptance**: The pull request contains only the planned changes and every required check passes for the exact reviewed head.

### ⬜ Unit 4c: Merge and Downstream Handoff
**What**: Squash-merge the reviewed pull request, resolve the exact new `main` commit SHA, and report it with the final verified checksum for the native agent to pin.
**Output**: Merged pull request, exact merge SHA, and verified distribution checksum.
**Acceptance**: The pull request is merged and the exact SHA plus checksum are reported without editing Spoonjoy.

## Execution
- **TDD strictly enforced**: tests → red → implement → green → refactor
- Commit after each phase (1a, 1b, 1c)
- Push after each unit complete
- Run full test suite before marking unit done
- For UI/rendering/layout units, run `visual-qa-dogfood` before declaring the unit or task complete
- **All artifacts**: Save outputs, logs, and data to the local-only `./2026-08-22-0508-doing-dependency-audit-refresh/` directory. Do not stage or force-add any artifact; verify the directory and task documents are absent from the final PR diff.
- **Warning policy**: `npm ci --loglevel=error`, audit, typecheck, test, coverage, and build must exit zero and emit no lines explicitly labeled `WARN` or `warning`. Ordinary npm package/funding summaries are informational, not warnings.
- **Fixes/blockers**: Spawn sub-agent immediately — don't ask, just do it
- **Decisions made**: Update docs immediately, commit right away

## Progress Log
- 2026-08-22 05:08 Created from planning doc
- 2026-08-22 05:15 Granularity pass addressed explicit-output, lifecycle-splitting, and baseline-ownership findings
- 2026-08-22 05:19 Ambiguity pass fixed the mutation algorithm, artifact policy, candidate freeze/review loop, PR scope, merge strategy, and warning definition

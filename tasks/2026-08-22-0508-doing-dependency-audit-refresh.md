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
**Acceptance**: The focused test exists and fails against the current workflow for the missing audit command.

### ⬜ Unit 1b: CI Audit Gate — Implementation
**What**: Add `- run: npm audit --audit-level=moderate` immediately after `- run: npm ci` in `.github/workflows/ci.yml`.
**Acceptance**: The focused test and full test suite pass with no warnings; no unrelated workflow behavior changes.

### ⬜ Unit 1c: CI Audit Gate — Coverage and Refactor
**What**: Run coverage, confirm the new test introduces no uncovered executable code, and simplify only if needed while keeping the assertion exact.
**Acceptance**: Existing coverage thresholds remain at 100%, the full suite stays green, and the CI contract test remains readable and deterministic.

### ⬜ Unit 2a: Dependency Repair — Failing Contract
**What**: From a frozen install at the committed baseline, run `npm audit --audit-level=moderate` and save its non-zero output. Record `npm ls brace-expansion nanoid postcss` so the repair is bounded to the demonstrated vulnerable paths.
**Acceptance**: The command fails specifically on the three known high advisories, establishing the red dependency contract.

### ⬜ Unit 2b: Dependency Repair — Minimal Lockfile Update
**What**: Run the narrowest package-lock-only audit repair. Review `package-lock.json` line-by-line, retain only patched compatible versions required along the three affected paths, and do not change `package.json`.
**Acceptance**: `npm ci --loglevel=error` succeeds, `npm audit --audit-level=moderate` exits zero, `package.json` SHA-256 is unchanged, and an artifact maps every lockfile delta to a known advisory path.

### ⬜ Unit 2c: Dependency Repair — Verification
**What**: Run `npm ls brace-expansion nanoid postcss`, typecheck, tests, and coverage from the repaired frozen install; save audit and dependency-tree evidence.
**Acceptance**: All commands pass, no vulnerable version remains in the installed tree, all tests pass, and coverage remains 100% with no warnings.

### ⬜ Unit 3: Independent Build and Distribution Verification
**What**: In two disposable clean checkouts of the exact candidate commit, run `npm ci --loglevel=error`, `npm audit --audit-level=moderate`, `npm run typecheck`, `npm test`, `npm run coverage`, and `npm run build`. In each checkout compute `find dist -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}'`, compare file lists, and save both checksums.
**Output**: Two clean-build validation logs and checksums in the artifacts directory.
**Acceptance**: Both full validation runs pass; checksums equal one another and `9f64507b03a5dc76a6ebc52f88cddf71f9448a8e532e4758951d2d31309d5a45`. If not, stop and produce a byte-level `dist` diff for reviewer disposition.

### ⬜ Unit 4: Cold Review, Pull Request, CI, and Merge
**What**: Request a fresh cold review of the complete diff and validation artifacts. Address all blocker, major, and actionable minor findings, push atomic commits, open a focused pull request, monitor required CI to success, and merge using repository policy.
**Output**: Merged pull request, exact merge SHA, and final verified distribution checksum.
**Acceptance**: Cold review converges, CI passes on the reviewed head, the pull request is merged, and the exact merged SHA plus checksum are reported for Spoonjoy pinning without editing Spoonjoy.

## Execution
- **TDD strictly enforced**: tests → red → implement → green → refactor
- Commit after each phase (1a, 1b, 1c)
- Push after each unit complete
- Run full test suite before marking unit done
- For UI/rendering/layout units, run `visual-qa-dogfood` before declaring the unit or task complete
- **All artifacts**: Save outputs, logs, data to `./2026-08-22-0508-doing-dependency-audit-refresh/` directory
- **Fixes/blockers**: Spawn sub-agent immediately — don't ask, just do it
- **Decisions made**: Update docs immediately, commit right away

## Progress Log
- 2026-08-22 05:08 Created from planning doc

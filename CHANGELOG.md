# Changelog

- Every command passes the kit's parse first, so an unknown flag, a missing argument or a bad value is refused with the kit's error (exit 2 usage, or 3 invalid), before any work runs.
- **Breaking for commands other people see:** `--why "<who asked you, and what they said>"` is now required on `testflight publish`, `xcode run`, `signing create-certificate`, `signing profiles`, `signing revoke-api-certificates`, and `developer keys apply|reconcile` and `developer services apply|reconcile`. This applies to `--mode dry-run` too. A caller that passed none must add it.
- `--dry-run` on a command other people see previews what it would do and who would see it, and sends nothing. `signing revoke-api-certificates` keeps its own `--dry-run`.
- A malformed `--team-id`, `--key-id` or identifier on a `developer` command other people see is refused before anything runs, and the error says where to get a right one.
- The command table declares every command's flags. A flag it does not declare is refused.
- The kit's validation errors echo the value they refuse, so a typed value appears in the error line. Do not pass a secret as a flag value.

## Unreleased

- CI's npm audit runs through `scripts/audit-allowance.cjs`, which lets an advisory with no fixed version through `audit-allowance.json` for an exact package version until a set date: today picomatch's ReDoS ([GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)), until 2026-12-17. Any other advisory, or an expired or incomplete allowance, still fails.
- The command list and `--help` come from one command table (`src/command-table.ts`), rendered by the vendored Ouro AX kit (`src/ouro-ax/`). `--help --json` is machine-readable and lists every command with its effect.
- `APPLE_DISTRIBUTION_ASC_BASE_URL` points App Store Connect calls at a mock. It is refused unless the host is 127.0.0.1 or ::1.
- The Ouro AX X-ray and the action-claims check run in CI (`.github/workflows/ax.yml`), and the X-ray gates the build: every must claim holds against the made-up mock.

## 0.2.0

**Breaking: exit codes.** The CLI now uses Ouro AX's exit table (0 ok, 1 error, 2 usage, then its own codes from 3). Before, it used sysexits.

| Meaning | 0.1.0 | 0.2.0 |
| --- | --- | --- |
| ok | 0 | 0 |
| error | 1 | 1 |
| usage (missing or wrong argument) | 64 | 2 |
| invalid (manifest or value) | 65 | 3 |
| no input (missing file or failed login) | 66 | 4 |
| unavailable (Apple or a local tool did not answer) | 69 | 5 |

A caller that only tests for a non-zero exit is unaffected. A caller that matches the numbers must change them.

**Breaking: `--json` errors.** An error is now `{ "error": { "code", "exit", "thing", "problem", "fix", "message" } }`, with no `ok` field. Before, it was `{ "ok": false, "error": { "code", "message" } }`. Results that report a state (for example an uncertain developer result) keep their `ok` field.

Ouro AX: the CLI pins the AX kit at Ouro UI v1.3.204 and declares its read-only actions with ouro-actions 0.16.0.

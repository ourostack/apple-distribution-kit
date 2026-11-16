# Changelog

## Unreleased

- The command list and `--help` come from one command table (`src/command-table.ts`), rendered by the vendored Ouro AX kit (`src/ouro-ax/`). `--help --json` is machine-readable and lists every command with its effect.
- `APPLE_DISTRIBUTION_ASC_BASE_URL` points App Store Connect calls at a mock. It is refused unless the host is 127.0.0.1 or ::1.
- The Ouro AX X-ray and the action-claims check run in CI (`.github/workflows/ax.yml`). The X-ray step does not yet block, because not every command family runs through the kit.

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

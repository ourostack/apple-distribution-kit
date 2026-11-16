/**
 * The exit codes of apple-distribution-kit: Ouro AX's base table (0 ok, 1 error, 2 usage), then this tool's own,
 * numbered from 3 with no gaps. The table matches what `defineExitCodes` in Ouro AX builds; a test checks it.
 */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  invalid: 3,
  noInput: 4,
  unavailable: 5
} as const;

export const EXIT_CODE_TABLE = [
  { code: 0, name: "ok", short: "ok", meaning: "ok" },
  { code: 1, name: "error", short: "error", meaning: "error: the message says what to do" },
  { code: 2, name: "usage", short: "usage", meaning: "usage: a missing or wrong argument; nothing was done" },
  { code: 3, name: "invalid", short: "invalid", meaning: "invalid: the manifest or a value is invalid; the message says what to fix" },
  { code: 4, name: "no-input", short: "no input", meaning: "no-input: a file or login the command needs is missing or failed" },
  { code: 5, name: "unavailable", short: "unavailable", meaning: "unavailable: Apple or a local tool did not answer; retry later" }
] as const;

import { createCli as createCliCore, type CliDependencies, type CliIo } from "../src/cli-core.js";

// Commands other people see: the kit requires --why on each. Tests that exercise their behaviour pass it through here;
// test/command-table.test.ts checks that the requirement itself holds.
const OTHERS: readonly (readonly string[])[] = [
  ["testflight", "publish"],
  ["xcode", "run"],
  ["signing", "create-certificate"],
  ["signing", "profiles"],
  ["signing", "revoke-api-certificates"],
  ["developer", "keys", "apply"],
  ["developer", "keys", "reconcile"],
  ["developer", "services", "apply"],
  ["developer", "services", "reconcile"],
];

const startsWith = (argv: readonly string[], index: number, words: readonly string[]) => words.every((word, i) => argv[index + i] === word);

export function withWhy(argv: string[]): string[] {
  if (argv.includes("--why") || argv.includes("--help")) return argv;
  const others = argv.some((_, index) => OTHERS.some((words) => startsWith(argv, index, words)));
  return others ? [...argv, "--why", "test"] : argv;
}

export function createCli(io: CliIo, dependencies: CliDependencies = {}) {
  const cli = createCliCore(io, dependencies);
  return (argv: string[]) => cli(withWhy(argv));
}

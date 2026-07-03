#!/usr/bin/env node
import { createCli } from "./cli-core.js";

const cli = createCli({
  stdout: (chunk) => process.stdout.write(chunk),
  stderr: (chunk) => process.stderr.write(chunk)
});

const exitCode = await cli(process.argv.slice(2));
process.exitCode = exitCode;

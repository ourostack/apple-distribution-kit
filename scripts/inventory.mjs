// The command names the CLI registers, read from its own command table, for the Ouro AX X-ray's inventory.
// Run after `npm run build`: node scripts/inventory.mjs > inventory.json
import { commands } from "../dist/command-table.js";

process.stdout.write(`${JSON.stringify({ cli: commands.map((command) => command.name) }, null, 2)}\n`);

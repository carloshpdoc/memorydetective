import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for the runtime version string. Reads from
// package.json so the CLI banner, the MCP server handshake, and any other
// surface that reports a version can never drift out of sync with the
// published artifact.
//
// Layout assumption: this file (compiled to dist/version.js) sits one level
// below package.json — true both at dev time (src/ ↔ package.json) and after
// `npm install` (node_modules/<pkg>/dist/ ↔ node_modules/<pkg>/package.json).
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string };

export const VERSION: string = pkg.version;

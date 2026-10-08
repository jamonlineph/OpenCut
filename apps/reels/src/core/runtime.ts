import { resolve } from "node:path";

import { compiled, which } from "./exec";

export { compiled };

const SCRIPTS = {
  studio: "../studio/server.ts",
  mcp: "../mcp/index.ts",
  cli: "../cli.ts",
} as const;

/**
 * The command that starts one of OpenCut's tools: the app's engine binary with a
 * subcommand, or `bun <script>` when running from the repository.
 */
export function selfCommand(tool: keyof typeof SCRIPTS): string[] {
  if (compiled) return tool === "cli" ? [process.execPath] : [process.execPath, tool];
  return [which("bun") ?? process.execPath, resolve(import.meta.dir, SCRIPTS[tool])];
}

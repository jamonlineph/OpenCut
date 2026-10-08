#!/usr/bin/env bun
// Entry point of the single-file engine bundled in OpenCut.app:
//
//   opencut-engine studio [--port N] [--parent-pid PID]   the Studio + autopilot
//   opencut-engine mcp                                     MCP server for AI clients
//   opencut-engine <cli command> …                         same as `bun run reels …`

const command = process.argv[2];

if (command === "studio") {
  process.argv.splice(2, 1);
  await import("./studio/server");
} else if (command === "mcp") {
  process.argv.splice(2, 1);
  await import("./mcp/index");
} else {
  await import("./cli");
}

export {};

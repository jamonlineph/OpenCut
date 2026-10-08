import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { run, which } from "./exec";
import { selfCommand } from "./runtime";

// Hooks OpenCut's MCP server into the AI apps on this Mac, so you can say
// "make a reel from my newest video" in Claude, Codex or Antigravity.

export type AiClient = "claude-code" | "claude-desktop" | "codex";

export function mcpEntry() {
  const [command, ...args] = selfCommand("mcp");
  return { command: command!, args };
}

const claudeDesktopConfig = () => join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");

export function mcpSetupText(): string {
  const { command, args } = mcpEntry();
  const quoted = [command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  const json = JSON.stringify({ mcpServers: { opencut: { command, args } } }, null, 2);
  return `OpenCut MCP server: ${quoted}

── Claude Code ──────────────────────────────────────────
claude mcp add --scope user opencut -- ${quoted}

── Claude Desktop ───────────────────────────────────────
Settings → Developer → Edit Config, then merge into claude_desktop_config.json:
${json}

── Codex (~/.codex/config.toml) ─────────────────────────
[mcp_servers.opencut]
command = ${JSON.stringify(command)}
args = [${args.map((a) => JSON.stringify(a)).join(", ")}]
tool_timeout_sec = 300

── Antigravity ──────────────────────────────────────────
Agent panel → … → MCP Servers → Manage → View raw config, then merge:
${json}
`;
}

export function clientsAvailable(): Record<AiClient, boolean> {
  return {
    "claude-code": Boolean(which("claude")),
    "claude-desktop": existsSync(dirname(claudeDesktopConfig())),
    codex: Boolean(which("codex")),
  };
}

/** Registers OpenCut with an AI app. Returns a sentence describing what happened. */
export async function connectClient(client: AiClient): Promise<string> {
  const { command, args } = mcpEntry();
  if (client === "claude-desktop") {
    const file = claudeDesktopConfig();
    mkdirSync(dirname(file), { recursive: true });
    let config: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf8");
      try {
        config = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        throw new Error(`Claude Desktop's config file isn't valid JSON, so it was left alone: ${file}`);
      }
      copyFileSync(file, `${file}.before-opencut`);
    }
    config.mcpServers = { ...config.mcpServers, opencut: { command, args } };
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    return "Added OpenCut to Claude Desktop. Quit and reopen Claude Desktop to use it.";
  }

  const bin = which(client === "claude-code" ? "claude" : "codex");
  if (!bin) throw new Error(`${client === "claude-code" ? "Claude Code" : "Codex"} isn't installed on this Mac.`);
  if (client === "claude-code") {
    await run([bin, "mcp", "remove", "--scope", "user", "opencut"]); // fine if it wasn't there
    const r = await run([bin, "mcp", "add", "--scope", "user", "opencut", "--", command, ...args]);
    if (r.code !== 0) throw new Error(`claude mcp add failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return "Added OpenCut to Claude Code. New Claude Code sessions can use it.";
  }
  await run([bin, "mcp", "remove", "opencut"]);
  const r = await run([bin, "mcp", "add", "opencut", "--", command, ...args]);
  if (r.code !== 0) throw new Error(`codex mcp add failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}. Use the config snippet instead.`);
  return "Added OpenCut to Codex.";
}

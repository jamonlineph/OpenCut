import { join } from "node:path";

import { run, which } from "../exec";
import { selfCommand } from "../runtime";
import type { AutopilotSettings, Workspace } from "../workspace";
import { writeJson } from "../workspace";

// Director that hands the job to a headless coding agent (Claude Code or Codex)
// connected to OpenCut's MCP server. Uses the creator's existing subscription,
// and the agent can render, look at its work and fix it, like in a chat.

export type AgentKind = "claude-code" | "codex";

export function agentAvailable(kind: AgentKind): boolean {
  return Boolean(which(kind === "claude-code" ? "claude" : "codex"));
}

/** Writes the MCP config the agent should load and returns its path. */
export function writeMcpConfig(ws: Workspace): string {
  const file = join(ws.autopilot, "mcp.json");
  const [command, ...args] = selfCommand("mcp");
  writeJson(file, { mcpServers: { opencut: { command, args, env: { OPENCUT_WORKSPACE: ws.root } } } });
  return file;
}

export function agentCommand(ws: Workspace, kind: AgentKind, settings: AutopilotSettings, prompt: string): string[] {
  const mcpConfig = writeMcpConfig(ws);
  const [mcpCommand, ...mcpArgs] = selfCommand("mcp");
  const fill = (parts: string[]) => parts.map((p) => p.replaceAll("{prompt}", prompt).replaceAll("{mcpConfig}", mcpConfig));
  if (settings.agentCommand.length) return fill(settings.agentCommand);
  if (kind === "claude-code") {
    return [
      which("claude") ?? "claude",
      "-p",
      prompt,
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      // Only OpenCut's tools: the agent can't touch anything else on the Mac.
      "--allowedTools",
      "mcp__opencut",
    ];
  }
  return [
    which("codex") ?? "codex",
    "exec",
    "--skip-git-repo-check",
    "-c",
    `mcp_servers.opencut.command=${JSON.stringify(mcpCommand)}`,
    "-c",
    `mcp_servers.opencut.args=[${mcpArgs.map((a) => JSON.stringify(a)).join(",")}]`,
    "-c",
    `mcp_servers.opencut.env={OPENCUT_WORKSPACE=${JSON.stringify(ws.root)}}`,
    "-c",
    "mcp_servers.opencut.tool_timeout_sec=300",
    prompt,
  ];
}

export async function runAgent(ws: Workspace, kind: AgentKind, settings: AutopilotSettings, prompt: string, log: (line: string) => void): Promise<string> {
  const cmd = agentCommand(ws, kind, settings, prompt);
  log(`Running ${kind}…`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.agentTimeoutMinutes * 60_000);
  try {
    const result = await run(cmd, {
      cwd: ws.root,
      signal: controller.signal,
      onStdout: (chunk) => chunk.split("\n").filter((l) => l.trim()).forEach((l) => log(l.slice(0, 500))),
    });
    if (controller.signal.aborted) throw new Error(`${kind} took longer than ${settings.agentTimeoutMinutes} minutes and was stopped.`);
    if (result.code !== 0) throw new Error(`${kind} exited with code ${result.code}: ${result.stderr.trim().split("\n").slice(-5).join(" ")}`);
    return result.stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

export function directPrompt(projectId: string, facts: string, maxReels: number): string {
  return `You are running unattended as the autopilot video editor for OpenCut. No human will answer questions, so make good decisions on your own.

A new drop was imported as OpenCut project "${projectId}" and has already been transcribed.
${facts}

Use the opencut tools:
1. get_style_guide, and follow it.
2. get_project and get_transcript. Use view_media to look at the footage and at any images listed above.
3. Edit the reel with the edit tool: cut false starts, retakes and tangents (remove_retakes helps), put the strongest line first as the hook with a short hook title, pin images where they are talked about, captions on. If the footage holds several self-contained ideas, make up to ${maxReels} reels: create_project with the same video file for each extra reel and shape it with the keep op.
4. For every reel: render a preview, check it with view_render, fix any problem, then render with quality "final".
5. Save each reel's publish copy with the notes op, formatted as "Title: …\\nCaption: …\\nHashtags: #a #b".

Finish with one line per reel: the project id and its title.`;
}

export function revisePrompt(projectId: string, instruction: string): string {
  return `You are the video editor for OpenCut, running unattended. Open OpenCut project "${projectId}" (get_project, get_transcript, get_style_guide).

The creator asks: ${instruction}

Make that change with the edit tool, changing only what the request needs. Render a preview and check it with view_render; fix problems you see. Don't render final unless the creator asked for it. Finish with one sentence describing what you changed.`;
}

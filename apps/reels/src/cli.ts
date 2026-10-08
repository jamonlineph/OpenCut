#!/usr/bin/env bun
import { resolve } from "node:path";

import { doctor } from "./core/capabilities";
import { which } from "./core/exec";
import { analyzeProject, createProject, editContext, listProjects, loadProject } from "./core/project";
import { renderProject } from "./core/render/render";
import { autoEdit, describeProject, listInbox } from "./core/service";
import { downloadModel, MODELS, type ModelName } from "./core/setup";
import { formatTranscript } from "./core/transcript-view";
import { workspace } from "./core/workspace";

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const args = rest.filter((a) => !a.startsWith("--"));
const option = (name: string) => {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
};

const ws = workspace();

async function printDoctor() {
  console.log(`Workspace: ${ws.root}\n`);
  for (const c of await doctor(ws)) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}${c.fix ? `\n    fix: ${c.fix}` : ""}`);
  }
}

function mcpConfig() {
  const bun = which("bun") ?? "bun";
  const entry = resolve(import.meta.dir, "mcp/index.ts");
  const json = JSON.stringify({ mcpServers: { opencut: { command: bun, args: [entry] } } }, null, 2);
  console.log(`OpenCut MCP server: ${entry}

── Claude Code ──────────────────────────────────────────
claude mcp add --scope user opencut -- ${bun} ${entry}

── Claude Desktop ───────────────────────────────────────
Settings → Developer → Edit Config, then merge into claude_desktop_config.json:
${json}

── Codex (~/.codex/config.toml) ─────────────────────────
[mcp_servers.opencut]
command = "${bun}"
args = ["${entry}"]
tool_timeout_sec = 300

── Antigravity ──────────────────────────────────────────
Agent panel → … → MCP Servers → Manage → View raw config, then merge:
${json}
`);
}

const HELP = `OpenCut Reels

  bun run setup [--model NAME]        download the Whisper model and check your Mac
  bun run doctor                      check FFmpeg, whisper.cpp and the model
  bun run studio                      open the editor in your browser
  bun run mcp                         start the MCP server (your AI client runs this)

  bun run reels mcp-config            print setup snippets for Claude / Codex / Antigravity
  bun run reels inbox                 list dropped files
  bun run reels list                  list projects
  bun run reels new NAME FILE... [--auto] [--render] [--final]
  bun run reels auto PROJECT          remove silences + fillers, zooms, captions
  bun run reels render PROJECT [--final]
  bun run reels show PROJECT          project summary
  bun run reels transcript PROJECT

Workspace: ${ws.root}  (set OPENCUT_WORKSPACE to change)
Models: ${Object.entries(MODELS).map(([k, v]) => `${k} (${v.size})`).join(", ")}`;

async function main() {
  switch (command) {
    case "setup": {
      const model = (option("--model") ?? "large-v3-turbo-q5_0") as ModelName;
      if (!MODELS[model]) throw new Error(`Unknown model. Pick one of: ${Object.keys(MODELS).join(", ")}`);
      await downloadModel(ws, model);
      console.log("");
      await printDoctor();
      console.log(`\nNext: drop videos into ${ws.inbox} and run: bun run studio`);
      break;
    }
    case "doctor":
      await printDoctor();
      break;
    case "mcp-config":
      mcpConfig();
      break;
    case "inbox":
      for (const i of listInbox(ws)) console.log(`${i.kind.padEnd(5)} ${i.name}${i.duration ? `  ${i.duration.toFixed(1)}s` : ""}`);
      break;
    case "list":
      for (const p of listProjects(ws)) console.log(`${p.id}  "${p.name}"  rev ${p.revision}`);
      break;
    case "new": {
      const [name, ...files] = args;
      if (!name || !files.length) throw new Error("Usage: bun run reels new NAME FILE...");
      let project = createProject(ws, name, files);
      console.log(`Created ${project.id}. Analyzing…`);
      let last = "";
      project = await analyzeProject(ws, project, () => {
        const line = describeProject(ws, project.id).split("\n").filter((l) => l.includes("%")).join(" | ");
        if (line && line !== last) console.log(`  ${(last = line).trim()}`);
      });
      if (flags.has("--auto")) console.log((await autoEdit(ws, project.id)).summary.join("\n"));
      if (flags.has("--render")) {
        const r = await renderProject(ws, project.id, flags.has("--final") ? "final" : "preview");
        console.log(`Rendered ${r.duration.toFixed(1)}s in ${r.seconds.toFixed(0)}s → ${r.output}`);
        r.warnings.forEach((w) => console.warn(`warning: ${w}`));
      }
      console.log(`\n${describeProject(ws, project.id)}`);
      break;
    }
    case "auto":
      console.log((await autoEdit(ws, args[0]!)).summary.join("\n"));
      break;
    case "render": {
      const r = await renderProject(ws, args[0]!, flags.has("--final") ? "final" : "preview");
      console.log(`Rendered ${r.duration.toFixed(1)}s in ${r.seconds.toFixed(0)}s → ${r.output}`);
      r.warnings.forEach((w) => console.warn(`warning: ${w}`));
      break;
    }
    case "show":
      console.log(describeProject(ws, args[0]!));
      break;
    case "transcript": {
      const p = loadProject(ws, args[0]!);
      console.log(formatTranscript(p, editContext(ws, p), { detail: flags.has("--words") ? "words" : "phrases" }));
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});

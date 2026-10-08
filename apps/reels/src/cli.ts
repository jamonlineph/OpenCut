#!/usr/bin/env bun
import { basename, extname, join, resolve } from "node:path";

import { approveJob, Autopilot, discardJob, listJobs, loadEnvFile, retryJob, reviseJob, runJob } from "./core/autopilot";
import { doctor } from "./core/capabilities";
import { directorLabel, pickDirector, reviseProject } from "./core/director";
import { mcpSetupText } from "./core/connect";
import { installLaunchAgent, uninstallLaunchAgent } from "./core/launchd";
import { compiled } from "./core/runtime";
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
loadEnvFile(ws);

async function printDoctor() {
  console.log(`Workspace: ${ws.root}\n`);
  for (const c of await doctor(ws)) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}${c.fix ? `\n    fix: ${c.fix}` : ""}`);
  }
  console.log(`✓ AI director: ${directorLabel(pickDirector(ws))}${pickDirector(ws) === "basic" ? "\n    for AI edits: install Claude Code (claude.ai/code) or add ANTHROPIC_API_KEY to " + resolve(ws.root, ".env") : ""}`);
}

function mcpConfig() {
  console.log(mcpSetupText());
}

const HELP = `OpenCut Reels

  bun run setup [--model NAME]        download the Whisper model and check your Mac
  bun run doctor                      check FFmpeg, whisper.cpp and the model
  bun run studio                      open the editor in your browser
  bun run mcp                         start the MCP server (your AI client runs this)

  Hands-free (drop a video, get a finished reel in the outbox):
  bun run reels autopilot             watch ${ws.autoEdit}
  bun run reels auto-edit FILE... [--review]
                                      edit these files now, like dropping them
                                      (--review: wait for your OK instead of exporting)
  bun run reels jobs                  recent autopilot jobs
  bun run reels approve JOB           export a job that is waiting for your OK
  bun run reels revise JOB PROJECT "what to change"
  bun run reels discard JOB           drop a job waiting for review (reels stay in the Studio)
  bun run reels retry JOB             run a failed job again
  bun run reels ask PROJECT "make the hook punchier"
  bun run reels install-agent         start OpenCut at login (macOS), so drops work any time
  bun run reels uninstall-agent

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
    case "autopilot": {
      const pilot = new Autopilot(ws, { log: (l) => console.log(l) });
      if (!pilot.start()) throw new Error("Another OpenCut process (probably the Studio) is already watching the auto-edit folder.");
      console.log(`Autopilot (${directorLabel(pickDirector(ws))}) is watching ${ws.autoEdit}\nFinished reels go to ${ws.outbox}. Ctrl+C to stop.`);
      let last = "";
      setInterval(() => {
        const job = listJobs(ws, 1)[0];
        const line = job ? `[${job.status}] ${job.name}: ${job.step}` : "";
        if (line && line !== last) console.log((last = line));
      }, 1000);
      await new Promise(() => {});
      break;
    }
    case "auto-edit": {
      if (!args.length) throw new Error("Usage: bun run reels auto-edit FILE... (a video, plus optional photos and a notes.txt)");
      const paths = args.map((a) => resolve(a));
      const video = paths.find((p) => /\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(p));
      const name = option("--name") ?? (video ? basename(video, extname(video)) : "reel");
      let last = "";
      const job = await runJob(ws, { name, paths }, {
        approve: flags.has("--review"),
        onChange: (j) => {
          const line = `[${j.status}] ${j.step}`;
          if (line !== last) console.log((last = line));
        },
      });
      console.log(`\n${job.summary ?? ""}`);
      for (const o of job.outputs) console.log(`→ ${o.file}`);
      for (const p of job.previews ?? []) if (job.status === "review") console.log(`preview: ${join(ws.root, p.file)}`);
      if (job.status === "review") console.log(`\nWaiting for your OK: ${compiled ? process.execPath : "bun run reels"} approve ${job.id}`);
      break;
    }
    case "approve": {
      const job = await approveJob(ws, args[0] ?? "", { onChange: (j) => console.log(`[${j.status}] ${j.step}`) });
      for (const o of job.outputs) console.log(`→ ${o.file}`);
      break;
    }
    case "revise": {
      const [jobId, projectId, ...words] = args;
      if (!jobId || !projectId || !words.length) throw new Error('Usage: bun run reels revise JOB PROJECT "what to change"');
      const job = await reviseJob(ws, jobId, projectId, words.join(" "), { onChange: (j) => console.log(`[${j.status}] ${j.step}`) });
      for (const p of job.previews ?? []) console.log(`preview: ${join(ws.root, p.file)}`);
      break;
    }
    case "discard":
      console.log(discardJob(ws, args[0] ?? "").step);
      break;
    case "jobs":
      for (const j of listJobs(ws)) {
        console.log(`${j.id}  [${j.status}] ${j.name}${j.director ? ` (${j.director})` : ""}${j.error ? ` — ${j.error}` : ""}`);
        for (const o of j.outputs) console.log(`    → ${o.file}`);
        if (j.status === "review") for (const p of j.previews ?? []) console.log(`    preview (${p.project}): ${join(ws.root, p.file)}`);
      }
      break;
    case "retry": {
      const job = await retryJob(ws, args[0]!, { onChange: (j) => console.log(`[${j.status}] ${j.step}`) });
      for (const o of job.outputs) console.log(`→ ${o.file}`);
      break;
    }
    case "ask": {
      const [id, ...words] = args;
      if (!id || !words.length) throw new Error('Usage: bun run reels ask PROJECT "what to change"');
      const result = await reviseProject(ws, id, words.join(" "), { onStep: (s) => console.log(s), log: (l) => console.log(`  ${l}`) });
      console.log(result.summary);
      result.warnings.forEach((w) => console.warn(`warning: ${w}`));
      break;
    }
    case "install-agent": {
      const file = await installLaunchAgent(ws);
      console.log(`OpenCut now starts at login (${file}).\nDrop videos into ${ws.autoEdit} any time. Studio: http://localhost:4317`);
      break;
    }
    case "uninstall-agent":
      console.log((await uninstallLaunchAgent()) ? "Removed. OpenCut no longer starts at login." : "OpenCut wasn't set to start at login.");
      break;
    default:
      console.log(HELP);
  }
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});

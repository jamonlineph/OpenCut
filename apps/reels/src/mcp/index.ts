#!/usr/bin/env bun
// OpenCut Reels MCP server (stdio). Never write to stdout here except through
// the transport: stdout is the protocol channel.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { readAnalysis } from "../core/analysis";
import { listJobs } from "../core/autopilot";
import { EditOp } from "../core/ops";
import { editContext, findAsset, isAnalyzed, listProjects, loadProject, projectDir, readState, revertProject, resolveMediaPath } from "../core/project";
import { contactSheet, grabFrames } from "../core/render/frames";
import { isRendering, listRenders, renderProject } from "../core/render/render";
import { AUTO_EDIT, describeProject, editProject, ensureAnalyzed, listInbox, startProject } from "../core/service";
import { probe } from "../core/probe";
import { formatTranscript } from "../core/transcript-view";
import { workspace } from "../core/workspace";

const ws = workspace();
const STUDIO_URL = `http://localhost:${process.env.OPENCUT_STUDIO_PORT ?? 4317}`;

const INSTRUCTIONS = `OpenCut edits vertical short-form videos (Reels, Shorts, TikTok) from files the user drops in ${ws.inbox}.

Workflow:
1. get_style_guide — the user's editing rules. Follow them.
2. list_inbox → create_project with the video(s). Analysis (transcription, silence detection) runs automatically; poll get_project(wait_seconds) until it is done.
3. get_transcript — numbered words (#id). Decide the story: hook, best takes, ending. Cut false starts and repeated takes.
4. edit with a list of ops. Cuts use word ids, so you never compute timestamps. Typical first pass: ${AUTO_EDIT.map((o) => o.op).join(", ")}. Read the creator's brief in get_project; record what you learn about the reel's purpose with the brief op.
5. view_media to look at footage and dropped images before placing overlays or changing framing.
6. render (quality "preview" first), then view_render to check captions, overlays and framing. Fix and re-render. Finish with quality "final".
Edits are versioned; revert undoes. The user can watch and tweak the same project live in OpenCut Studio at ${STUDIO_URL}.`;

const server = new McpServer({ name: "opencut", version: "0.1.0" }, { instructions: INSTRUCTIONS });

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });

async function guard(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
}

async function waitFor(check: () => boolean, seconds: number) {
  const until = Date.now() + Math.min(seconds, 55) * 1000;
  while (!check() && Date.now() < until) await Bun.sleep(1000);
}

const ProjectId = z.string().describe("Project id from create_project or list_projects");

server.registerTool(
  "get_style_guide",
  { title: "Get style guide", description: "The user's editing rules (STYLE.md). Read before editing.", annotations: { readOnlyHint: true } },
  () => guard(() => text(readFileSync(ws.styleGuide, "utf8"))),
);

server.registerTool(
  "save_style_guide",
  {
    title: "Save style guide",
    description: "Replace the user's style guide. Use when the user asks you to remember an editing preference. Send the full new markdown.",
    inputSchema: { markdown: z.string().min(20) },
  },
  ({ markdown }) =>
    guard(() => {
      writeFileSync(ws.styleGuide, markdown);
      return text(`Saved ${ws.styleGuide}.`);
    }),
);

server.registerTool(
  "list_inbox",
  { title: "List inbox", description: `Videos, images and music the user dropped in ${ws.inbox} (plus brand/music).`, annotations: { readOnlyHint: true } },
  () =>
    guard(() => {
      const items = listInbox(ws);
      if (!items.length) return text(`The inbox is empty. Ask the user to drop videos into ${ws.inbox} or the Studio at ${STUDIO_URL}.`);
      return text(
        items
          .map((i) => {
            const dims = i.width ? ` ${i.width}x${i.height}` : "";
            const dur = i.duration && i.kind !== "image" ? ` ${i.duration.toFixed(1)}s` : "";
            return `${i.kind.padEnd(5)} ${i.name}${dims}${dur}  (modified ${i.modified.slice(0, 16).replace("T", " ")}${i.analyzed ? ", analyzed" : ""})`;
          })
          .join("\n"),
      );
    }),
);

server.registerTool(
  "list_projects",
  { title: "List projects", description: "Existing reel projects, newest first.", annotations: { readOnlyHint: true } },
  () =>
    guard(() => {
      const projects = listProjects(ws);
      if (!projects.length) return text("No projects yet. Use create_project.");
      return text(projects.map((p) => `${p.id}  "${p.name}"  rev ${p.revision}  updated ${p.updatedAt.slice(0, 16).replace("T", " ")}`).join("\n"));
    }),
);

server.registerTool(
  "create_project",
  {
    title: "Create project",
    description:
      "Start a reel from one or more inbox videos (played in the order given). Transcribes and detects silences automatically. " +
      "To cut several shorts from one long video, create one project per short with the same file; analysis is cached.",
    inputSchema: {
      name: z.string().describe("Short name, e.g. the topic"),
      files: z.array(z.string()).min(1).describe("Inbox file names of the videos"),
      wait_seconds: z.number().min(0).max(55).optional().describe("Wait this long for analysis (default 45)"),
    },
  },
  ({ name, files, wait_seconds }) =>
    guard(async () => {
      for (const f of files) {
        const rel = resolveMediaPath(ws, f);
        if (!rel.match(/\.(mp4|mov|m4v|mkv|webm|avi)$/i)) throw new Error(`${f} is not a video. Add images later with an add_overlay edit.`);
      }
      const { project, analysis } = startProject(ws, name, files);
      const done = await Promise.race([
        analysis.then(() => true, () => true),
        Bun.sleep(Math.min(wait_seconds ?? 45, 55) * 1000).then(() => false),
      ]);
      return text(`${describeProject(ws, project.id)}\n\nNext: ${done ? "get_style_guide, then get_transcript" : "get_project with wait_seconds until analysis finishes"}.`);
    }),
);

server.registerTool(
  "get_project",
  {
    title: "Get project",
    description: "Project summary: analysis progress, clips (source → reel times), overlays, text, captions, music, render status.",
    inputSchema: { project: ProjectId, wait_seconds: z.number().min(0).max(55).optional().describe("Wait up to this long for analysis or a render to finish") },
    annotations: { readOnlyHint: true },
  },
  ({ project, wait_seconds }) =>
    guard(async () => {
      ensureAnalyzed(ws, project);
      if (wait_seconds) {
        await waitFor(() => isAnalyzed(ws, loadProject(ws, project)) && readState(ws, project).render.status !== "running", wait_seconds);
      }
      return text(describeProject(ws, project));
    }),
);

server.registerTool(
  "get_transcript",
  {
    title: "Get transcript",
    description:
      "The project's transcript with word ids. Default view: one line per phrase, '#first-#last [source times] text', with cut words in ~~strikes~~ and long pauses marked. " +
      "detail='words' lists every word with exact source times.",
    inputSchema: {
      project: ProjectId,
      from_word: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(3000).optional().describe("Max words (default 600)"),
      detail: z.enum(["phrases", "words"]).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  ({ project, from_word, limit, detail }) =>
    guard(() => {
      const p = loadProject(ws, project);
      if (!isAnalyzed(ws, p)) return text("Still analyzing. Call get_project with wait_seconds first.");
      return text(formatTranscript(p, editContext(ws, p), { fromWord: from_word, limit, detail }));
    }),
);

server.registerTool(
  "edit",
  {
    title: "Edit reel",
    description:
      "Apply edit operations in order and save a new revision. Word ids come from get_transcript. Times called start/end are seconds in the finished reel. Examples:\n" +
      '[{"op":"remove_silences"},{"op":"remove_fillers"},{"op":"cut","from":40,"to":52},{"op":"move_to_start","from":120,"to":131},' +
      '{"op":"add_text","text":"Stop doing this","start":0,"end":2.5},{"op":"add_overlay","asset":"chart.png","from":60,"to":68,"layout":"top"},' +
      '{"op":"auto_zoom"},{"op":"captions","style":"bold","maxWords":3}]',
    inputSchema: { project: ProjectId, ops: z.array(EditOp).min(1) },
  },
  ({ project, ops }) =>
    guard(async () => {
      const { summary } = await editProject(ws, project, ops);
      return text(`${summary.join("\n")}\n\n${describeProject(ws, project)}`);
    }),
);

server.registerTool(
  "auto_edit",
  {
    title: "Auto edit",
    description: `Standard first pass for a talking-head reel: ${AUTO_EDIT.map((o) => o.op).join(", ")}. Review the transcript afterwards for retakes and the hook.`,
    inputSchema: { project: ProjectId },
  },
  ({ project }) =>
    guard(async () => {
      const { summary } = await editProject(ws, project, AUTO_EDIT);
      return text(`${summary.join("\n")}\n\n${describeProject(ws, project)}`);
    }),
);

server.registerTool(
  "revert",
  {
    title: "Revert",
    description: "Undo: restore an earlier revision (listed in get_project). Saved as a new revision, so it can be undone too.",
    inputSchema: { project: ProjectId, revision: z.number().int().min(0) },
  },
  ({ project, revision }) =>
    guard(() => {
      revertProject(ws, project, revision);
      return text(describeProject(ws, project));
    }),
);

server.registerTool(
  "view_media",
  {
    title: "View media",
    description:
      "Look at a source video or image. For video, either specific source times or a contact sheet (a grid of frames every N seconds). " +
      "Use it to check framing (focusX) and to see dropped images before placing them.",
    inputSchema: {
      file: z.string().describe("Inbox file name, or an asset id when project is given"),
      project: ProjectId.optional(),
      times: z.array(z.number().min(0)).max(8).optional().describe("Source times in seconds"),
      every: z.number().min(0.5).optional().describe("Contact sheet interval in seconds (default: about 12 frames)"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ file, project, times, every }) =>
    guard(async () => {
      const rel = project ? findAsset(loadProject(ws, project), file).file : resolveMediaPath(ws, file);
      const a = readAnalysis(ws, rel);
      const source = a.source;
      if (!a.info || a.info.kind === "image" || !a.info.duration) {
        const [frame] = await grabFrames(source, [0], 640);
        return { content: [{ type: "image", data: frame!.jpeg.toString("base64"), mimeType: "image/jpeg" }, { type: "text", text: `${rel}${a.info ? ` ${a.info.width}x${a.info.height}` : ""}` }] };
      }
      if (times?.length) {
        const frames = await grabFrames(source, times, 480);
        return {
          content: frames.flatMap((f) => [
            { type: "text" as const, text: `${rel} at ${f.time}s:` },
            { type: "image" as const, data: f.jpeg.toString("base64"), mimeType: "image/jpeg" },
          ]),
        };
      }
      const sheet = await contactSheet(source, a.info.duration, every ?? Math.max(1, a.info.duration / 12));
      return {
        content: [
          { type: "image", data: sheet.jpeg.toString("base64"), mimeType: "image/jpeg" },
          { type: "text", text: `${rel}: frames left-to-right, top-to-bottom at ${sheet.times.join(", ")}s (source ${a.info.width}x${a.info.height}).` },
        ],
      };
    }),
);

server.registerTool(
  "render",
  {
    title: "Render",
    description: "Render the current revision to MP4 (1080x1920). preview = fast half-resolution check; final = full quality for posting.",
    inputSchema: {
      project: ProjectId,
      quality: z.enum(["preview", "final"]).optional(),
      wait_seconds: z.number().min(0).max(55).optional().describe("Wait this long for the render (default 50). Poll get_project if it isn't done."),
    },
  },
  ({ project, quality, wait_seconds }) =>
    guard(async () => {
      if (!isRendering(project)) {
        renderProject(ws, project, quality ?? "preview").catch(() => {}); // Error lands in state.json.
      }
      await Bun.sleep(300);
      await waitFor(() => readState(ws, project).render.status !== "running", wait_seconds ?? 50);
      const r = readState(ws, project).render;
      if (r.status === "running") return text(`Rendering… ${Math.round(r.progress * 100)}%. Call get_project with wait_seconds to wait.`);
      if (r.status === "error") throw new Error(`Render failed: ${r.error}`);
      return text(`Rendered → ${join(projectDir(ws, project), r.output!)}\nUse view_render to check it. Studio: ${STUDIO_URL}/#/p/${project}`);
    }),
);

server.registerTool(
  "view_render",
  {
    title: "View render",
    description: "Look at frames of the latest render (reel times in seconds) to check captions, overlays, text and framing.",
    inputSchema: {
      project: ProjectId,
      times: z.array(z.number().min(0)).max(8).optional().describe("Reel times; default is a contact sheet"),
    },
    annotations: { readOnlyHint: true },
  },
  ({ project, times }) =>
    guard(async () => {
      const latest = listRenders(ws, project)[0];
      if (!latest) throw new Error("No renders yet. Call render first.");
      const p = loadProject(ws, project);
      const stale = !latest.file.includes(`/r${p.revision}-`);
      const note = stale ? " (older than the current revision — re-render to see recent edits)" : "";
      if (times?.length) {
        const frames = await grabFrames(latest.path, times, 360);
        return {
          content: frames.flatMap((f) => [
            { type: "text" as const, text: `${latest.file} at ${f.time}s${note}:` },
            { type: "image" as const, data: f.jpeg.toString("base64"), mimeType: "image/jpeg" },
          ]),
        };
      }
      const d = (await probe(latest.path, "video")).duration;
      const sheet = await contactSheet(latest.path, d, Math.max(1, d / 10), 5);
      return {
        content: [
          { type: "image", data: sheet.jpeg.toString("base64"), mimeType: "image/jpeg" },
          { type: "text", text: `${latest.file}${note}: frames at ${sheet.times.join(", ")}s.` },
        ],
      };
    }),
);

server.registerTool(
  "list_autopilot_jobs",
  {
    title: "List autopilot jobs",
    description: `Recent hands-free jobs: videos dropped into ${ws.autoEdit} that were edited automatically, with their status, reels and output files.`,
    annotations: { readOnlyHint: true },
  },
  () =>
    guard(() => {
      const jobs = listJobs(ws, 15);
      if (!jobs.length) return text(`No autopilot jobs yet. Videos dropped into ${ws.autoEdit} are edited automatically while OpenCut Studio runs.`);
      return text(
        jobs
          .map((j) =>
            [
              `${j.createdAt.slice(0, 16).replace("T", " ")} "${j.name}" [${j.status}] ${j.director ?? ""}${j.error ? ` — ${j.error}` : ""}`,
              ...j.outputs.map((o) => `   project ${o.project}: "${o.title}" ${o.duration.toFixed(1)}s → ${o.file}`),
            ].join("\n"),
          )
          .join("\n"),
      );
    }),
);

server.registerResource(
  "style-guide",
  "opencut://style-guide",
  { title: "Editing style guide", description: "The user's editing rules", mimeType: "text/markdown" },
  (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: readFileSync(ws.styleGuide, "utf8") }] }),
);

server.registerPrompt(
  "make_reel",
  {
    title: "Make a reel",
    description: "Turn a talking-head video into a finished reel",
    argsSchema: { file: z.string().describe("Inbox video file"), notes: z.string().optional().describe("Anything specific for this reel") },
  },
  ({ file, notes }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Make a reel from "${file}" in my OpenCut inbox. Read my style guide first and follow it.\n` +
            `1. create_project, wait for analysis, read the transcript.\n` +
            `2. Run auto_edit, then cut false starts, repeated takes and rambling. Pick the strongest hook and move it to the start if needed, with a short hook title.\n` +
            `3. If I dropped images, look at them with view_media and place each where I talk about it.\n` +
            `4. Render a preview, check it with view_render, fix problems, then render final.\n` +
            `5. Save a title, caption and 5 hashtags with the notes op and tell me where the file is.` +
            (notes ? `\n\nNotes: ${notes}` : ""),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "clips_from_long_video",
  {
    title: "Cut several shorts from a long video",
    description: "Find the best moments in one long video and make a reel of each",
    argsSchema: { file: z.string().describe("Inbox video file"), count: z.string().optional().describe("How many shorts (default 3)") },
  },
  ({ file, count }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Find the ${count ?? "3"} best self-contained moments (30-60s each) in "${file}" from my OpenCut inbox and turn each into its own reel. ` +
            `Read my style guide first. Create one project and read the full transcript to choose the moments. Then create one project per moment ` +
            `(same file; analysis is cached), use the keep op with that moment's word range, and finish each reel per the style guide: hook, captions, zooms, preview, check, final render. ` +
            `Summarize each reel with its title and file path.`,
        },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());

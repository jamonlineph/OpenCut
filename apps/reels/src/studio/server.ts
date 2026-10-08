#!/usr/bin/env bun
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

import { analyzeMedia, readAnalysis } from "../core/analysis";
import { Autopilot, listJobs, loadEnvFile, retryJob } from "../core/autopilot";
import { directorLabel, pickDirector, reviseProject } from "../core/director";
import { doctor } from "../core/capabilities";
import { run, which } from "../core/exec";
import type { EditOp } from "../core/ops";
import { deleteProject, editContext, listProjects, listRevisions, loadProject, projectDir, readState, revertProject } from "../core/project";
import { captionChunks } from "../core/render/captions";
import { isRendering, listRenders, renderProject } from "../core/render/render";
import { AUTO_EDIT, editProject, ensureAnalyzed, listInbox, startProject } from "../core/service";
import { frameSnap, keptWords, placeClips, resolveTime, totalDuration } from "../core/timeline";
import { mediaKindOf, workspace } from "../core/workspace";
import index from "./index.html";

const ws = workspace();
loadEnvFile(ws);
const port = Number(process.env.OPENCUT_STUDIO_PORT ?? 4317);

// The Studio also runs the autopilot, so anything dropped into the auto-edit
// folder (or onto the Studio with auto-edit on) is edited automatically.
const autopilot = new Autopilot(ws, { log: (line) => console.log(`[autopilot] ${line}`) });
const autopilotEnabled = !process.argv.includes("--no-autopilot") && process.env.OPENCUT_AUTOPILOT !== "0";
const autopilotStarted = autopilotEnabled && autopilot.start();

/** "Ask AI" requests running in this process, by project id. */
type AskState = { status: "running" | "done" | "error"; instruction: string; step: string; summary?: string; error?: string };
const asks = new Map<string, AskState>();

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (error: unknown, status = 400) => json({ error: error instanceof Error ? error.message : String(error) }, status);

async function handle(fn: () => unknown | Promise<unknown>) {
  try {
    const result = await fn();
    return result instanceof Response ? result : json(result ?? { ok: true });
  } catch (error) {
    return fail(error);
  }
}

/** Serves a workspace file with HTTP range support so <video> can seek. */
function serveFile(req: Request, abs: string) {
  const root = resolve(ws.root);
  const full = resolve(abs);
  const inside = full.startsWith(root + sep) || full.startsWith(resolve(ws.cache) + sep);
  if (!inside || !existsSync(full)) return new Response("Not found", { status: 404 });
  const file = Bun.file(full);
  const size = statSync(full).size;
  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (!range) return new Response(file, { headers: { "Accept-Ranges": "bytes", "Content-Length": String(size) } });
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Content-Type": file.type,
    },
  });
}

const mediaUrl = (rel: string) => `/media/${rel.split("/").map(encodeURIComponent).join("/")}`;
const thumbUrl = (rel: string) => `/thumb?file=${encodeURIComponent(rel)}`;

function projectView(id: string) {
  ensureAnalyzed(ws, id);
  const project = loadProject(ws, id);
  const state = readState(ws, id);
  const ctx = editContext(ws, project);
  const snapped = { ...project, clips: project.clips.map((c) => frameSnap(c, project.canvas.fps)) };
  const placed = placeClips(snapped);
  const kept = keptWords(ctx, placed);
  const keptIds = new Set(kept.map((w) => w.id));
  const outTime = new Map(kept.map((w) => [w.id, w.outStart]));
  const assetInfo = Object.fromEntries(
    project.assets.map((a) => {
      const an = readAnalysis(ws, a.file);
      return [
        a.id,
        {
          ...a,
          url: mediaUrl(a.file),
          thumb: thumbUrl(a.file),
          duration: an.info?.duration ?? 0,
          width: an.info?.width ?? 0,
          height: an.info?.height ?? 0,
          status: an.status,
        },
      ];
    }),
  );
  const resolveSpan = (item: { start: Parameters<typeof resolveTime>[0]; end: Parameters<typeof resolveTime>[0] }) => ({
    outStart: resolveTime(item.start, "start", ctx, placed),
    outEnd: resolveTime(item.end, "end", ctx, placed),
  });
  return {
    project,
    state,
    assets: assetInfo,
    duration: totalDuration(snapped),
    clips: placed.map((p) => ({ ...p.clip, outStart: p.outStart, outEnd: p.outEnd })),
    words: ctx.words.map((w) => ({ ...w, kept: keptIds.has(w.id), outStart: outTime.get(w.id) ?? null })),
    captions: captionChunks(kept, project.captions.maxWords).map((c) => ({
      start: c.start,
      end: c.end,
      words: c.words.map((w) => ({ text: w.text, start: w.outStart, end: w.outEnd })),
    })),
    overlays: project.overlays.map((o) => ({ ...o, ...resolveSpan(o) })),
    texts: project.texts.map((t) => ({ ...t, ...resolveSpan(t) })),
    renders: listRenders(ws, id).map((r) => ({ file: r.file, url: mediaUrl(join("projects", id, r.file)), size: r.size, mtime: r.mtime })),
    revisions: listRevisions(ws, id),
    ai: asks.get(id) ?? null,
  };
}

export type ProjectView = ReturnType<typeof projectView>;
export type StudioState = {
  root: string;
  inbox: (ReturnType<typeof listInbox>[number] & { url: string; thumb: string })[];
  projects: { id: string; name: string; updatedAt: string; revision: number; duration: number; thumb: string | null; render: string }[];
};

async function reveal(abs: string) {
  const open = which("open");
  if (!open) throw new Error(`Open this folder yourself: ${abs}`);
  await run(existsSync(abs) && statSync(abs).isFile() ? [open, "-R", abs] : [open, abs]);
}

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  routes: {
    "/": index,
    "/api/state": {
      GET: () =>
        handle((): StudioState => ({
          root: ws.root,
          inbox: listInbox(ws).map((i) => ({ ...i, url: mediaUrl(i.file), thumb: thumbUrl(i.file) })),
          projects: listProjects(ws).map((p) => ({
            id: p.id,
            name: p.name,
            updatedAt: p.updatedAt,
            revision: p.revision,
            duration: totalDuration(p),
            thumb: p.assets[0] ? thumbUrl(p.assets[0].file) : null,
            render: readState(ws, p.id).render.status,
          })),
        })),
    },
    "/api/doctor": { GET: () => handle(() => doctor(ws)) },
    "/api/autopilot": {
      GET: () =>
        handle(() => {
          const director = pickDirector(ws);
          return {
            enabled: autopilotEnabled,
            watching: autopilot.watching,
            elsewhere: autopilotEnabled && !autopilotStarted,
            director,
            directorLabel: directorLabel(director),
            folder: ws.autoEdit,
            outbox: ws.outbox,
            jobs: listJobs(ws, 15).map((j) => ({ ...j, log: j.log.slice(-6) })),
          };
        }),
    },
    "/api/autopilot/retry": {
      POST: (req) =>
        handle(async () => {
          const { id } = (await req.json()) as { id: string };
          retryJob(ws, id).catch(() => {});
          await Bun.sleep(300);
        }),
    },
    "/api/upload/commit": {
      // Turns a finished upload batch into one auto-edit drop (video + photos + notes together).
      POST: (req) =>
        handle(async () => {
          const { batch, name } = (await req.json()) as { batch: string; name: string };
          const from = join(ws.autoEdit, `.batch-${batch.replace(/\W/g, "")}`);
          if (!existsSync(from)) throw new Error("Upload batch not found.");
          const clean = basename(name, extname(name)).replace(/[^\w.\- ()]+/g, "_") || "drop";
          let dest = join(ws.autoEdit, clean);
          for (let n = 2; existsSync(dest); n++) dest = join(ws.autoEdit, `${clean} ${n}`);
          renameSync(from, dest);
          return { folder: basename(dest) };
        }),
    },
    "/api/upload": {
      PUT: (req) =>
        handle(async () => {
          const params = new URL(req.url).searchParams;
          const name = basename(params.get("name") ?? "").replace(/[^\w.\- ()]+/g, "_");
          const batch = params.get("batch")?.replace(/\W/g, "");
          if (!name || !(mediaKindOf(name) || (batch && /\.(txt|md)$/i.test(name)))) throw new Error("Only video, image and audio files can be added.");
          if (batch) {
            // Hidden folder: the autopilot ignores it until the batch is committed.
            const dir = join(ws.autoEdit, `.batch-${batch}`);
            mkdirSync(dir, { recursive: true });
            await Bun.write(join(dir, name), new Response(req.body));
            return { file: name };
          }
          let dest = join(ws.inbox, name);
          for (let n = 2; existsSync(dest); n++) dest = join(ws.inbox, `${n}-${name}`);
          await Bun.write(dest, new Response(req.body));
          const file = `inbox/${basename(dest)}`;
          // Start transcribing right away so making a reel from it is instant.
          analyzeMedia(ws, file).catch(() => {});
          return { file };
        }),
    },
    "/api/reveal": {
      POST: (req) =>
        handle(async () => {
          const { path } = (await req.json()) as { path?: string };
          const abs = path ? resolve(ws.root, path) : ws.inbox;
          if (!abs.startsWith(resolve(ws.root))) throw new Error("Outside the workspace");
          await reveal(abs);
        }),
    },
    "/api/projects": {
      POST: (req) =>
        handle(async () => {
          const { name, files } = (await req.json()) as { name: string; files: string[] };
          const { project } = startProject(ws, name || "New reel", files);
          return { id: project.id };
        }),
    },
    "/api/projects/:id": {
      GET: (req) => handle(() => projectView(req.params.id)),
      DELETE: (req) => handle(() => deleteProject(ws, req.params.id)),
    },
    "/api/projects/:id/edit": {
      POST: (req) =>
        handle(async () => {
          const { ops } = (await req.json()) as { ops: EditOp[] };
          const { summary } = await editProject(ws, req.params.id, ops);
          return { summary, view: projectView(req.params.id) };
        }),
    },
    "/api/projects/:id/auto": {
      POST: (req) =>
        handle(async () => {
          const { summary } = await editProject(ws, req.params.id, AUTO_EDIT);
          return { summary, view: projectView(req.params.id) };
        }),
    },
    "/api/projects/:id/revert": {
      POST: (req) =>
        handle(async () => {
          const { revision } = (await req.json()) as { revision: number };
          revertProject(ws, req.params.id, revision);
          return { view: projectView(req.params.id) };
        }),
    },
    "/api/projects/:id/render": {
      POST: (req) =>
        handle(async () => {
          const { quality } = (await req.json()) as { quality: "preview" | "final" };
          if (!isRendering(req.params.id)) renderProject(ws, req.params.id, quality).catch(() => {});
          await Bun.sleep(200);
          return { state: readState(ws, req.params.id) };
        }),
    },
    "/api/projects/:id/ask": {
      POST: (req) =>
        handle(async () => {
          const id = req.params.id;
          const { instruction } = (await req.json()) as { instruction: string };
          if (!instruction?.trim()) throw new Error("Tell the AI what to change.");
          if (asks.get(id)?.status === "running") throw new Error("The AI is still working on the last request.");
          const state: AskState = { status: "running", instruction, step: "Starting…" };
          asks.set(id, state);
          reviseProject(ws, id, instruction, { onStep: (step) => (state.step = step) })
            .then((r) => Object.assign(state, { status: "done", step: "Done", summary: [r.summary, ...r.warnings].join("\n") }))
            .catch((e) => Object.assign(state, { status: "error", step: "Failed", error: e instanceof Error ? e.message : String(e) }));
          return { ok: true };
        }),
    },
    "/api/projects/:id/reveal": {
      POST: (req) =>
        handle(async () => {
          const r = listRenders(ws, req.params.id)[0];
          await reveal(r ? r.path : projectDir(ws, req.params.id));
        }),
    },
  },
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/media/")) {
      const rel = url.pathname.slice("/media/".length).split("/").map(decodeURIComponent).join("/");
      return serveFile(req, join(ws.root, rel));
    }
    if (url.pathname === "/thumb") {
      const rel = url.searchParams.get("file") ?? "";
      const thumb = readAnalysis(ws, rel).thumb;
      if (thumb) return serveFile(req, thumb);
      // Images can show themselves until their thumbnail exists.
      return mediaKindOf(rel) === "image"
        ? serveFile(req, join(ws.root, rel))
        : new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`OpenCut Studio → http://localhost:${server.port}`);
console.log(`Drop videos into ${ws.inbox} or onto the Studio window.`);
if (autopilotStarted) console.log(`Autopilot (${directorLabel(pickDirector(ws))}): drop videos into ${ws.autoEdit} → finished reels in ${ws.outbox}`);
else if (autopilotEnabled) console.log("Autopilot is already running in another OpenCut process.");
// Clean up upload batches left behind by a closed browser tab.
for (const name of existsSync(ws.autoEdit) ? Array.from(new Bun.Glob(".batch-*").scanSync({ cwd: ws.autoEdit, onlyFiles: false, dot: true })) : []) {
  const dir = join(ws.autoEdit, name);
  if (Date.now() - statSync(dir).mtimeMs > 6 * 3600_000) rmSync(dir, { recursive: true, force: true });
}
if (process.argv.includes("--open")) {
  const open = which("open");
  if (open) Bun.spawn([open, `http://localhost:${server.port}`]);
}

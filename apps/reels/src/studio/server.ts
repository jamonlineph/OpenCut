#!/usr/bin/env bun
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

import { analyzeMedia, readAnalysis } from "../core/analysis";
import { approveJob, Autopilot, discardJob, listJobs, loadEnvFile, refreshReview, retryJob, reviseJob, type Job } from "../core/autopilot";
import { directorLabel, pickDirector, reviseProject } from "../core/director";
import { doctor } from "../core/capabilities";
import { clientsAvailable, connectClient, mcpSetupText, type AiClient } from "../core/connect";
import { run, which } from "../core/exec";
import type { EditOp } from "../core/ops";
import { deleteProject, editContext, listProjects, listRevisions, loadProject, projectDir, readState, revertProject } from "../core/project";
import { captionChunks } from "../core/render/captions";
import { isRendering, listRenders, renderProject } from "../core/render/render";
import { AUTO_EDIT, editProject, ensureAnalyzed, listInbox, startProject } from "../core/service";
import { frameSnap, keptWords, placeClips, resolveTime, totalDuration } from "../core/timeline";
import { downloadModel, LANGUAGES, MODELS, type ModelName } from "../core/setup";
import { whisperBin } from "../core/transcribe";
import { mediaKindOf, readJson, readSettings, workspace, writeSettings, type Settings } from "../core/workspace";
import index from "./index.html";

const ws = workspace();
loadEnvFile(ws);
const argValue = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const port = Number(argValue("--port") ?? process.env.OPENCUT_STUDIO_PORT ?? 4317);

// When OpenCut.app starts the engine, quit together with the app even if it crashes.
const parentPid = Number(argValue("--parent-pid") ?? 0);
if (parentPid) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, 3000);
}

/** First-run setup done from the Studio: downloading the speech model. */
const setupState: { downloading: boolean; progress: number; error?: string } = { downloading: false, progress: 0 };

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

/** A job as the Studio shows it: previews get playable URLs. */
const jobView = (j: Job) => ({ ...j, previews: (j.previews ?? []).map((p) => ({ ...p, url: mediaUrl(p.file) })) });
const loadJob = (id: string) => {
  const job = readJson<Job>(join(ws.autopilot, "jobs", `${basename(id)}.json`));
  if (!job) throw new Error("Job not found.");
  return job;
};
/** Approve/revise run in the background; their errors are recorded on the job. */
const background = (work: Promise<unknown>) => void work.catch((e) => console.error(`[autopilot] ${e instanceof Error ? e.message : e}`));

/** The settings the Studio lets you change. */
function settingsView() {
  const s = readSettings(ws);
  const multilingual = !/\.en\.bin$/.test(s.whisperModel);
  return {
    approve: s.autopilot.approve,
    notify: s.autopilot.notify,
    language: s.language,
    languages: LANGUAGES,
    captionStyle: s.captionStyle,
    whisperModel: s.whisperModel,
    multilingual,
    models: Object.entries(MODELS).map(([name, m]) => ({ name, ...m, installed: existsSync(join(ws.models, m.file)) })),
  };
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
    "/api/setup": {
      GET: () =>
        handle(async () => {
          const settings = readSettings(ws);
          const model = join(ws.models, settings.whisperModel);
          const ffmpeg = (await doctor(ws)).find((c) => c.name === "FFmpeg")?.ok ?? false;
          return {
            ffmpeg,
            whisper: Boolean(whisperBin()),
            brew: Boolean(which("brew")),
            model: { file: settings.whisperModel, installed: existsSync(model), ...setupState },
            director: directorLabel(pickDirector(ws)),
          };
        }),
    },
    "/api/setup/model": {
      POST: (req) =>
        handle(async () => {
          const { model } = (await req.json().catch(() => ({}))) as { model?: ModelName };
          const name = model && MODELS[model] ? model : "large-v3-turbo-q5_0";
          if (setupState.downloading) return { ok: true };
          Object.assign(setupState, { downloading: true, progress: 0, error: undefined });
          downloadModel(ws, name, () => {}, (p) => (setupState.progress = p))
            .catch((e) => (setupState.error = e instanceof Error ? e.message : String(e)))
            .finally(() => (setupState.downloading = false));
          return { ok: true };
        }),
    },
    "/api/setup/brew": {
      // Opens Terminal with the Homebrew command, so nobody has to type it.
      POST: () =>
        handle(async () => {
          const osascript = which("osascript");
          if (!osascript) throw new Error("Open Terminal and run: brew install ffmpeg whisper-cpp");
          const cmd = which("brew")
            ? "brew install ffmpeg whisper-cpp"
            : '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && brew install ffmpeg whisper-cpp';
          await run([osascript, "-e", `tell application "Terminal" to do script ${JSON.stringify(cmd)}`, "-e", 'tell application "Terminal" to activate']);
        }),
    },
    "/api/connect": {
      GET: () => handle(() => ({ clients: clientsAvailable(), text: mcpSetupText() })),
      POST: (req) =>
        handle(async () => {
          const { client } = (await req.json()) as { client: AiClient };
          return { message: await connectClient(client) };
        }),
    },
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
            jobs: listJobs(ws, 15).map((j) => jobView({ ...j, log: j.log.slice(-6) })),
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
    "/api/autopilot/jobs/:id": {
      GET: (req) => handle(() => jobView(loadJob(req.params.id))),
    },
    "/api/autopilot/jobs/:id/approve": {
      POST: (req) =>
        handle(async () => {
          const { projects } = (await req.json().catch(() => ({}))) as { projects?: string[] };
          loadJob(req.params.id);
          background(approveJob(ws, req.params.id, { projects }));
          await Bun.sleep(150);
          return jobView(loadJob(req.params.id));
        }),
    },
    "/api/autopilot/jobs/:id/revise": {
      POST: (req) =>
        handle(async () => {
          const { project, note } = (await req.json()) as { project: string; note: string };
          if (pickDirector(ws) === "basic") throw new Error("Asking for changes needs an AI: install Claude Code or add an API key. You can still open the reel and edit it yourself.");
          background(reviseJob(ws, req.params.id, project, note ?? ""));
          await Bun.sleep(150);
          return jobView(loadJob(req.params.id));
        }),
    },
    "/api/autopilot/jobs/:id/refresh": {
      // After you edited a reel by hand: render its preview again.
      POST: (req) =>
        handle(async () => {
          background(refreshReview(ws, req.params.id));
          await Bun.sleep(150);
          return jobView(loadJob(req.params.id));
        }),
    },
    "/api/autopilot/jobs/:id/discard": {
      POST: (req) => handle(() => jobView(discardJob(ws, req.params.id))),
    },
    "/api/settings": {
      GET: () => handle(settingsView),
      POST: (req) =>
        handle(async () => {
          const body = (await req.json()) as { approve?: boolean; notify?: boolean; language?: string; captionStyle?: Settings["captionStyle"] };
          if (body.language !== undefined && !LANGUAGES.some(([code]) => code === body.language)) throw new Error(`Unknown language: ${body.language}`);
          writeSettings(ws, {
            ...(body.language !== undefined && { language: body.language }),
            ...(body.captionStyle !== undefined && { captionStyle: body.captionStyle }),
            autopilot: {
              ...(body.approve !== undefined && { approve: Boolean(body.approve) }),
              ...(body.notify !== undefined && { notify: Boolean(body.notify) }),
            },
          });
          return settingsView();
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

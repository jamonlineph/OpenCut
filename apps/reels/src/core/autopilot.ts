import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

import { directorLabel, directProject, pickDirector } from "./director";
import { parsePublish } from "./director/plan";
import { run, which } from "./exec";
import { listRenders, renderProject } from "./render/render";
import { loadProject, projectDir, readState } from "./project";
import { editProject, startProject } from "./service";
import { totalDuration } from "./timeline";
import { mediaKindOf, readJson, readSettings, slugify, writeJson, type Workspace } from "./workspace";

// Drop a video (or a folder with videos, photos and a notes.txt) into
// <workspace>/auto-edit and it is imported, edited by the AI director,
// rendered, and delivered to <workspace>/outbox with its publish copy.

export type JobStatus = "importing" | "analyzing" | "editing" | "rendering" | "done" | "error";

export type JobOutput = { project: string; file: string; title: string; caption: string; hashtags: string[]; duration: number };

export type Job = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  step: string;
  /** Workspace-relative media paths after import. */
  files: string[];
  notes: string;
  director?: string;
  projects: string[];
  outputs: JobOutput[];
  summary?: string;
  error?: string;
  log: string[];
};

/** A set of dropped paths that make one job. */
export type DropGroup = { name: string; paths: string[] };

const IGNORED = /^\.|\.(part|crdownload|download|tmp|icloud)$/i;
const isNote = (f: string) => /\.(txt|md)$/i.test(f);
const usable = (f: string) => !IGNORED.test(basename(f)) && (mediaKindOf(f) !== null || isNote(f));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (IGNORED.test(name)) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * Splits the drop folder into jobs. Each sub-folder is one reel (its videos are
 * joined in name order). Each loose video is its own reel; loose photos, music
 * and notes go with the video they share a name with, else with the first video.
 */
export function groupDrops(dir: string): { groups: DropGroup[]; loose: string[] } {
  const groups: DropGroup[] = [];
  const looseVideos: string[] = [];
  const looseOther: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (IGNORED.test(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      groups.push({ name, paths: walk(full).filter(usable).sort() });
    } else if (mediaKindOf(name) === "video") looseVideos.push(full);
    else if (usable(full)) looseOther.push(full);
  }
  const videoGroups = looseVideos.map((v) => ({ name: basename(v, extname(v)), paths: [v] }));
  for (const other of looseOther) {
    const stem = basename(other, extname(other)).toLowerCase();
    const owner = videoGroups.find((g) => g.name.toLowerCase() === stem) ?? videoGroups[0];
    owner?.paths.push(other);
  }
  return { groups: [...groups, ...videoGroups], loose: videoGroups.length ? [] : looseOther };
}

/** Size + modified time of everything in a group: unchanged means copying finished. */
function signature(paths: string[]): string {
  return paths.map((p) => (existsSync(p) ? `${statSync(p).size}:${statSync(p).mtimeMs}` : "gone")).join("|");
}

const jobsDir = (ws: Workspace) => join(ws.autopilot, "jobs");
const jobFile = (ws: Workspace, id: string) => join(jobsDir(ws), `${id}.json`);

export function listJobs(ws: Workspace, limit = 30): Job[] {
  if (!existsSync(jobsDir(ws))) return [];
  return readdirSync(jobsDir(ws))
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<Job>(join(jobsDir(ws), f)))
    .filter((j): j is Job => Boolean(j))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function loadEnvFile(ws: Workspace) {
  // launchd doesn't read your shell profile, so keys can live in <workspace>/.env.
  const file = join(ws.root, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
}

async function notify(title: string, message: string) {
  const osascript = which("osascript");
  if (!osascript) return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await run([osascript, "-e", `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`]).catch(() => {});
}

function uniquePath(dir: string, name: string): string {
  let dest = join(dir, name);
  const ext = extname(name);
  for (let n = 2; existsSync(dest); n++) dest = join(dir, `${basename(name, ext)} ${n}${ext}`);
  return dest;
}

export class Autopilot {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen = new Map<string, { sig: string; since: number }>();
  private queue: DropGroup[] = [];
  private busy = false;
  private claimed = new Set<string>();
  current: string | null = null;

  constructor(
    private ws: Workspace,
    private options: { onChange?: () => void; log?: (line: string) => void; settleMs?: number; strayMs?: number; pollMs?: number } = {},
  ) {}

  private get lockFile() {
    return join(this.ws.autopilot, "watcher.json");
  }

  /** Starts watching. Returns false if another OpenCut process is already watching. */
  start(): boolean {
    const owner = readJson<{ pid: number }>(this.lockFile);
    if (owner && owner.pid !== process.pid && pidAlive(owner.pid)) return false;
    writeJson(this.lockFile, { pid: process.pid, startedAt: new Date().toISOString() });
    process.once("exit", () => this.releaseLock());
    this.timer = setInterval(() => this.scan(), this.options.pollMs ?? 2000);
    this.scan();
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.releaseLock();
  }

  private releaseLock() {
    const owner = readJson<{ pid: number }>(this.lockFile);
    if (owner?.pid === process.pid) rmSync(this.lockFile, { force: true });
  }

  get watching() {
    return this.timer !== null;
  }

  status() {
    return { watching: this.watching, queued: this.queue.length, current: this.current };
  }

  /** Checks the drop folder; queues groups whose files have stopped changing. */
  scan() {
    if (!existsSync(this.ws.autoEdit)) mkdirSync(this.ws.autoEdit, { recursive: true });
    const { groups, loose } = groupDrops(this.ws.autoEdit);
    const now = Date.now();
    const settle = this.options.settleMs ?? 4000;
    const stableFor = (key: string, paths: string[]) => {
      const sig = signature(paths);
      const prev = this.seen.get(key);
      if (!prev || prev.sig !== sig) {
        this.seen.set(key, { sig, since: now });
        return 0;
      }
      return now - prev.since;
    };
    // Photos or music dropped without a video: after a while, file them in the library.
    const strays = [...loose, ...groups.filter((g) => !g.paths.some((p) => mediaKindOf(p) === "video")).flatMap((g) => g.paths)];
    if (strays.length && stableFor("\0strays", strays) > (this.options.strayMs ?? 120_000)) {
      for (const p of strays.filter((x) => mediaKindOf(x))) moveOrCopy(p, uniquePath(this.ws.inbox, basename(p)));
      for (const g of groups) {
        const dir = join(this.ws.autoEdit, g.name);
        if (existsSync(dir) && statSync(dir).isDirectory() && !walk(dir).some((f) => mediaKindOf(f))) rmSync(dir, { recursive: true, force: true });
      }
      this.seen.delete("\0strays");
      this.log(`Moved ${strays.length} photo/music file(s) without a video into the inbox.`);
    }
    for (const group of groups) {
      const key = group.name;
      if (this.claimed.has(key) || !group.paths.some((p) => mediaKindOf(p) === "video")) continue;
      if (stableFor(key, group.paths) < settle) continue;
      this.claimed.add(key);
      this.seen.delete(key);
      this.queue.push(group);
      this.log(`Queued "${group.name}" (${group.paths.length} file(s))`);
    }
    void this.drain();
  }

  private log(line: string) {
    this.options.log?.(line);
  }

  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const group = this.queue.shift()!;
        await runJob(this.ws, group, {
          onChange: (job) => {
            this.current = job.status === "done" || job.status === "error" ? null : job.id;
            this.options.onChange?.();
          },
        }).catch(() => {}); // Failures are recorded on the job.
        this.claimed.delete(group.name);
      }
    } finally {
      this.busy = false;
    }
  }
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Imports, edits, renders and delivers one drop. Works for paths inside or outside the drop folder. */
export async function runJob(ws: Workspace, group: DropGroup, hooks: { onChange?: (job: Job) => void } = {}): Promise<Job> {
  mkdirSync(jobsDir(ws), { recursive: true });
  const stamp = new Date().toISOString();
  const job: Job = {
    id: `${stamp.slice(0, 19).replace(/[-:T]/g, "")}-${slugify(group.name)}`.slice(0, 60),
    name: group.name,
    createdAt: stamp,
    updatedAt: stamp,
    status: "importing",
    step: "Importing files…",
    files: [],
    notes: "",
    projects: [],
    outputs: [],
    log: [],
  };
  const save = (patch: Partial<Job> = {}) => {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    job.log = job.log.slice(-300);
    writeJson(jobFile(ws, job.id), job);
    hooks.onChange?.(job);
  };
  const log = (line: string) => {
    job.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    save();
  };
  save();

  try {
    // 1. Import: media into the inbox library, notes into the job.
    const notesDir = join(ws.autopilot, "notes", job.id);
    const notes: string[] = [];
    for (const path of group.paths) {
      if (isNote(path)) {
        notes.push(readFileSync(path, "utf8").trim());
        mkdirSync(notesDir, { recursive: true });
        moveOrCopy(path, uniquePath(notesDir, basename(path)));
        continue;
      }
      const dest = uniquePath(ws.inbox, basename(path));
      moveOrCopy(path, dest);
      job.files.push(relative(ws.root, dest));
    }
    const dropFolder = join(ws.autoEdit, group.name);
    if (existsSync(dropFolder) && statSync(dropFolder).isDirectory() && walk(dropFolder).length === 0) rmSync(dropFolder, { recursive: true, force: true });
    job.notes = notes.filter(Boolean).join("\n\n");
    const videos = job.files.filter((f) => mediaKindOf(f) === "video");
    if (!videos.length) throw new Error("No video in this drop. Photos and music were added to the inbox.");
    log(`Imported ${job.files.length} file(s)${job.notes ? " and notes" : ""}.`);

    // 2. Analyze: transcribe and find silences.
    save({ status: "analyzing", step: "Transcribing…" });
    const ordered = [...videos, ...job.files.filter((f) => mediaKindOf(f) !== "video")];
    const { project, analysis } = startProject(ws, group.name, ordered);
    job.projects = [project.id];
    await analysis;
    const analysisErrors = Object.values(readState(ws, project.id).analysis).filter((s) => s.stage === "error");
    if (analysisErrors.length) throw new Error(analysisErrors[0]!.error ?? "Analysis failed");
    if (job.notes) await editProject(ws, project.id, [{ op: "brief", text: job.notes }]);

    // 3. Edit: the director understands the footage and decides the cut.
    const director = pickDirector(ws);
    save({ status: "editing", step: `${directorLabel(director)} is editing…`, director: directorLabel(director) });
    const result = await directProject(ws, project.id, { onStep: (step) => save({ step }), log });
    job.projects = result.projects;
    job.summary = result.summary;
    log(`Edited ${result.projects.length} reel(s) with ${directorLabel(result.director)}.`);

    // 4. Render the final version of every reel that doesn't have one yet.
    save({ status: "rendering" });
    for (const [i, id] of job.projects.entries()) {
      const p = loadProject(ws, id);
      const done = listRenders(ws, id).find((r) => r.file === `renders/r${p.revision}-final.mp4`);
      save({ step: `Rendering reel ${i + 1} of ${job.projects.length}…` });
      const output = done?.path ?? (await renderProject(ws, id, "final")).output;
      job.outputs.push(deliver(ws, id, output));
    }

    save({ status: "done", step: `${job.outputs.length} reel(s) ready in outbox` });
    await afterDone(ws, job);
    return job;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    save({ status: "error", step: "Failed", error: message });
    if (readSettings(ws).autopilot.notify) await notify("OpenCut couldn't finish a reel", `${job.name}: ${message.slice(0, 150)}`);
    throw error;
  }
}

function moveOrCopy(from: string, to: string) {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to, constants.COPYFILE_FICLONE);
  }
}

/** Copies a final render to the outbox with a text file of its publish copy. */
function deliver(ws: Workspace, projectId: string, render: string): JobOutput {
  const project = loadProject(ws, projectId);
  const publish = parsePublish(project.notes);
  const title = publish.title || project.name;
  const day = new Date().toISOString().slice(0, 10);
  const file = uniquePath(ws.outbox, `${day} ${title.replace(/[\\/:*?"<>|]+/g, "").slice(0, 70).trim() || project.id}.mp4`);
  copyFileSync(render, file, constants.COPYFILE_FICLONE);
  const copy = [
    publish.title && `${publish.title}\n`,
    publish.caption,
    publish.hashtags.length ? `\n${publish.hashtags.join(" ")}` : "",
    `\n---\nOpenCut project: ${project.id} (${projectDir(ws, projectId)})`,
  ].filter(Boolean).join("\n");
  writeFileSync(file.replace(/\.mp4$/, ".txt"), `${copy.trim()}\n`);
  return { project: projectId, file, title, caption: publish.caption, hashtags: publish.hashtags, duration: totalDuration(project) };
}

async function afterDone(ws: Workspace, job: Job) {
  const settings = readSettings(ws).autopilot;
  if (settings.notify) {
    const titles = job.outputs.map((o) => o.title).join(", ");
    await notify(`${job.outputs.length} reel${job.outputs.length === 1 ? "" : "s"} ready`, titles.slice(0, 180));
  }
  if (settings.webhookUrl) {
    try {
      await fetch(settings.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "reels.ready", job: { id: job.id, name: job.name, director: job.director, summary: job.summary }, reels: job.outputs }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      writeJson(jobFile(ws, job.id), { ...job, log: [...job.log, `webhook failed: ${(error as Error).message}`] });
    }
  }
}

/** Runs a failed job again from the files it already imported. */
export async function retryJob(ws: Workspace, jobId: string, hooks: { onChange?: (job: Job) => void } = {}): Promise<Job> {
  const old = readJson<Job>(jobFile(ws, jobId));
  if (!old) throw new Error(`Job ${jobId} not found.`);
  const tmp = join(ws.autopilot, "retry", jobId);
  mkdirSync(tmp, { recursive: true });
  if (old.notes) writeFileSync(join(tmp, "notes.txt"), old.notes);
  const paths = [...old.files.map((f) => join(ws.root, f)).filter(existsSync), ...(old.notes ? [join(tmp, "notes.txt")] : [])];
  rmSync(jobFile(ws, jobId), { force: true });
  // Files are already in the inbox: "move" them onto themselves by copying to a temp name first.
  const staged = paths.map((p) => {
    if (!p.startsWith(ws.inbox)) return p;
    const s = join(tmp, basename(p));
    renameSync(p, s);
    return s;
  });
  return runJob(ws, { name: old.name, paths: staged }, hooks);
}

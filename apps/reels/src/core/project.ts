import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

import { analyzeMedia, readAnalysis, type AnalysisStatus } from "./analysis";
import { round3 } from "./intervals";
import { nextId, Project, type Asset, type Clip } from "./schema";
import type { AssetData, EditContext, PWord } from "./timeline";
import { mediaKindOf, readJson, readSettings, slugify, writeJson, type Workspace } from "./workspace";

export const projectDir = (ws: Workspace, id: string) => join(ws.projects, id);
const projectFile = (ws: Workspace, id: string) => join(projectDir(ws, id), "project.json");

export type RenderState = {
  status: "idle" | "running" | "done" | "error";
  progress: number;
  quality?: "preview" | "final";
  /** Path relative to the project folder. */
  output?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type ProjectState = {
  analysis: Record<string, AnalysisStatus>;
  render: RenderState;
};

export function listProjects(ws: Workspace): Project[] {
  if (!existsSync(ws.projects)) return [];
  return readdirSync(ws.projects)
    .map((id) => readJson<unknown>(projectFile(ws, id)))
    .flatMap((raw) => {
      const parsed = Project.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function loadProject(ws: Workspace, id: string): Project {
  const raw = readJson<unknown>(projectFile(ws, id));
  if (!raw) throw new Error(`Project "${id}" not found. Use list_projects to see what exists.`);
  return Project.parse(raw);
}

/** Saves a new revision and keeps the previous one in history/ for revert. */
export function saveProject(ws: Workspace, project: Project): Project {
  const dir = projectDir(ws, project.id);
  const previous = readJson<Project>(projectFile(ws, project.id));
  if (previous) writeJson(join(dir, "history", `rev-${String(previous.revision).padStart(4, "0")}.json`), previous);
  const next = Project.parse({
    ...project,
    revision: (previous?.revision ?? project.revision) + 1,
    updatedAt: new Date().toISOString(),
  });
  writeJson(projectFile(ws, project.id), next);
  return next;
}

export function listRevisions(ws: Workspace, id: string): number[] {
  const dir = join(projectDir(ws, id), "history");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => Number(f.match(/^rev-(\d+)\.json$/)?.[1]))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

export function revertProject(ws: Workspace, id: string, revision: number): Project {
  const old = readJson<unknown>(join(projectDir(ws, id), "history", `rev-${String(revision).padStart(4, "0")}.json`));
  if (!old) throw new Error(`Revision ${revision} not found. Available: ${listRevisions(ws, id).join(", ")}`);
  const current = loadProject(ws, id);
  return saveProject(ws, { ...Project.parse(old), revision: current.revision });
}

export function deleteProject(ws: Workspace, id: string) {
  rmSync(projectDir(ws, id), { recursive: true, force: true });
}

export function readState(ws: Workspace, id: string): ProjectState {
  return readJson<ProjectState>(join(projectDir(ws, id), "state.json")) ?? { analysis: {}, render: { status: "idle", progress: 0 } };
}

export function writeState(ws: Workspace, id: string, patch: Partial<ProjectState>) {
  const state = { ...readState(ws, id), ...patch };
  writeJson(join(projectDir(ws, id), "state.json"), state);
  return state;
}

/**
 * Turns "talk.mp4", "inbox/talk.mp4" or an absolute path into a path relative
 * to the workspace. Files from elsewhere are copied into the inbox first (an
 * instant clone on APFS, so it costs no extra disk space on a Mac).
 */
export function resolveMediaPath(ws: Workspace, file: string): string {
  for (const c of [join(ws.inbox, file), join(ws.root, file), join(ws.music, file)]) {
    if (existsSync(c) && statSync(c).isFile()) return relative(ws.root, c);
  }
  if (isAbsolute(file) && existsSync(file) && statSync(file).isFile()) {
    const rel = relative(ws.root, file);
    if (!rel.startsWith("..")) return rel;
    let dest = join(ws.inbox, basename(file));
    for (let n = 2; existsSync(dest); n++) dest = join(ws.inbox, `${n}-${basename(file)}`);
    copyFileSync(file, dest, constants.COPYFILE_FICLONE);
    return relative(ws.root, dest);
  }
  throw new Error(`Media "${file}" not found in ${ws.inbox}. Use list_inbox to see available files.`);
}

/** Adds media to a project (if not already there) and returns its asset. */
export function addAsset(ws: Workspace, project: Project, file: string): Asset {
  const rel = resolveMediaPath(ws, file);
  const existing = project.assets.find((a) => a.file === rel);
  if (existing) return existing;
  const kind = mediaKindOf(rel);
  if (!kind) throw new Error(`Unsupported file type: ${file}`);
  const prefix = { video: "v", image: "img", audio: "a" }[kind];
  const count = project.assets.filter((a) => a.kind === kind).length + 1;
  let id = `${prefix}${count}`;
  while (project.assets.some((a) => a.id === id)) id = `${id}x`;
  const asset: Asset = { id, kind, file: rel, name: basename(rel) };
  project.assets.push(asset);
  return asset;
}

export function findAsset(project: Project, ref: string): Asset {
  const asset =
    project.assets.find((a) => a.id === ref) ??
    project.assets.find((a) => a.name === ref || a.file === ref || a.file.endsWith(`/${ref}`));
  if (!asset) throw new Error(`Asset "${ref}" is not in this project. Assets: ${project.assets.map((a) => `${a.id} (${a.name})`).join(", ")}`);
  return asset;
}

export function createProject(ws: Workspace, name: string, files: string[]): Project {
  let id = slugify(name);
  if (existsSync(projectDir(ws, id))) {
    let n = 2;
    while (existsSync(projectDir(ws, `${id}-${n}`))) n++;
    id = `${id}-${n}`;
  }
  mkdirSync(join(projectDir(ws, id), "renders"), { recursive: true });
  const settings = readSettings(ws);
  const stamp = new Date().toISOString();
  const project = Project.parse({ id, name, createdAt: stamp, updatedAt: stamp });
  project.captions.style = settings.captionStyle;
  for (const file of files) addAsset(ws, project, file);
  return saveProject(ws, project);
}

/** Analyzes every asset in a project, updating state.json as it goes. */
export async function analyzeProject(ws: Workspace, project: Project, onUpdate?: () => void) {
  const report = (assetId: string, status: AnalysisStatus) => {
    writeState(ws, project.id, { analysis: { ...readState(ws, project.id).analysis, [assetId]: status } });
    onUpdate?.();
  };
  await Promise.all(
    project.assets.map((asset) =>
      analyzeMedia(ws, asset.file, (status) => report(asset.id, status)).catch((error) => {
        report(asset.id, { stage: "error", progress: 0, error: String(error?.message ?? error), updatedAt: new Date().toISOString() });
        throw error;
      }),
    ),
  );
  // A fresh project starts with every video in full, in order.
  const latest = loadProject(ws, project.id);
  if (!latest.clips.length && latest.seq === 0) {
    const ctx = editContext(ws, latest);
    latest.clips = fullClips(latest, ctx);
    return saveProject(ws, latest);
  }
  return latest;
}

export function fullClips(project: Project, ctx: EditContext): Clip[] {
  return project.assets
    .filter((a) => a.kind === "video")
    .map((a) => ({ id: nextId(project, "c"), asset: a.id, in: 0, out: round3(ctx.assets.get(a.id)?.duration ?? 0), zoom: 1, focusX: 0.5, focusY: 0.5 }))
    .filter((c) => c.out > 0);
}

/** Loads analysis for every asset and numbers the transcript words project-wide. */
export function editContext(ws: Workspace, project: Project): EditContext {
  const words: PWord[] = [];
  const assets = new Map<string, AssetData>();
  for (const asset of project.assets) {
    const a = readAnalysis(ws, asset.file);
    assets.set(asset.id, {
      ready: a.info !== null,
      duration: a.info?.duration ?? 0,
      width: a.info?.width ?? 0,
      height: a.info?.height ?? 0,
      hasAudio: a.info?.hasAudio ?? false,
      audible: (a.info?.hasAudio ?? false) && (a.info?.kind === "audio" || (a.silence?.meanVolumeDb ?? 0) > -80),
      hdr: a.info?.hdr ?? false,
      silences: a.silence?.silences ?? [],
      noise: a.transcript?.noise ?? [],
      source: a.source,
    });
    if (asset.kind !== "video") continue;
    for (const w of a.transcript?.words ?? []) {
      words.push({ id: words.length, asset: asset.id, text: w.text, start: w.start, end: w.end, filler: w.filler });
    }
  }
  return { words, assets };
}

export function isAnalyzed(ws: Workspace, project: Project): boolean {
  return project.assets.every((a) => readAnalysis(ws, a.file).status?.stage === "done");
}

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { analyzeMedia, readAnalysis } from "./analysis";
import { applyEdits, type EditOp } from "./ops";
import {
  analyzeProject,
  createProject,
  editContext,
  isAnalyzed,
  listRevisions,
  loadProject,
  readState,
  saveProject,
} from "./project";
import { listRenders } from "./render/render";
import type { Project } from "./schema";
import { placeClips, resolveTime, totalDuration } from "./timeline";
import { mediaKindOf, readSettings, type Workspace } from "./workspace";

export type InboxItem = {
  name: string;
  /** Path relative to the workspace root. */
  file: string;
  kind: "video" | "image" | "audio";
  size: number;
  modified: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  analyzed: boolean;
};

export function listInbox(ws: Workspace): InboxItem[] {
  const out: InboxItem[] = [];
  for (const [dir, prefix] of [[ws.inbox, "inbox"], [ws.music, "brand/music"]] as const) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const kind = mediaKindOf(name);
      if (!kind) continue;
      const stat = statSync(join(dir, name));
      const file = `${prefix}/${name}`;
      const a = readAnalysis(ws, file);
      out.push({
        name,
        file,
        kind,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        duration: a.info?.duration ?? null,
        width: a.info?.width ?? null,
        height: a.info?.height ?? null,
        analyzed: a.status?.stage === "done",
      });
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

const analyzing = new Map<string, Promise<Project>>();

function analyzeInBackground(ws: Workspace, project: Project): Promise<Project> {
  const existing = analyzing.get(project.id);
  if (existing) return existing;
  const job = analyzeProject(ws, project).finally(() => analyzing.delete(project.id));
  job.catch(() => {}); // Errors are reported through state.json.
  analyzing.set(project.id, job);
  return job;
}

/** Creates a project and analyzes it in the background. */
export function startProject(ws: Workspace, name: string, files: string[]): { project: Project; analysis: Promise<Project> } {
  if (!files.length) throw new Error("Pick at least one video.");
  const project = createProject(ws, name, files);
  return { project, analysis: analyzeInBackground(ws, project) };
}

/** Restarts analysis that was interrupted (e.g. the app quit midway). */
export function ensureAnalyzed(ws: Workspace, id: string) {
  if (analyzing.has(id)) return;
  const project = loadProject(ws, id);
  const failed = project.assets.some((a) => readAnalysis(ws, a.file).status?.stage === "error");
  if (failed || (isAnalyzed(ws, project) && project.seq > 0)) return;
  analyzeInBackground(ws, project);
}

export async function editProject(ws: Workspace, id: string, ops: EditOp[]) {
  const project = loadProject(ws, id);
  if (!isAnalyzed(ws, project)) throw new Error("This project is still being analyzed. Call get_project to check progress.");
  const settings = readSettings(ws);
  const { project: edited, summary } = applyEdits(ws, project, ops, editContext(ws, project), settings);
  // Images and music added by these edits need probing before they can render.
  await Promise.all(edited.assets.filter((a) => !project.assets.some((p) => p.id === a.id)).map((a) => analyzeMedia(ws, a.file)));
  return { project: saveProject(ws, edited), summary };
}

/** The standard first pass for a talking-head reel. */
export const AUTO_EDIT: EditOp[] = [
  { op: "remove_retakes" },
  { op: "remove_silences" },
  { op: "remove_fillers" },
  { op: "auto_zoom", zoom: 1.12 },
  { op: "captions", enabled: true },
];

export function autoEdit(ws: Workspace, id: string) {
  return editProject(ws, id, AUTO_EDIT);
}

/** Everything an agent needs to know about a project, as readable text. */
export function describeProject(ws: Workspace, id: string): string {
  const project = loadProject(ws, id);
  const state = readState(ws, id);
  const lines = [`Project "${project.name}" (id: ${project.id}, revision ${project.revision})`];

  const pending = project.assets.filter((a) => readAnalysis(ws, a.file).status?.stage !== "done");
  if (pending.length) {
    lines.push("", "ANALYZING — wait before editing:");
    for (const a of pending) {
      const s = state.analysis[a.id] ?? readAnalysis(ws, a.file).status;
      lines.push(`  ${a.id} ${a.name}: ${s?.stage ?? "queued"} ${Math.round((s?.progress ?? 0) * 100)}%${s?.error ? ` — ERROR: ${s.error}` : ""}`);
    }
  }

  const ctx = editContext(ws, project);
  const placed = placeClips(project);
  lines.push("", "Assets:");
  for (const a of project.assets) {
    const d = ctx.assets.get(a.id);
    const words = ctx.words.filter((w) => w.asset === a.id);
    const dims = d?.width ? ` ${d.width}x${d.height}` : "";
    const dur = a.kind !== "image" && d?.duration ? ` ${d.duration.toFixed(1)}s` : "";
    const span = words.length ? ` words #${words[0]!.id}-#${words.at(-1)!.id}` : "";
    lines.push(`  ${a.id} ${a.kind} "${a.name}"${dims}${dur}${span}${d?.hdr ? " HDR" : ""}`);
  }

  lines.push("", `Reel: ${totalDuration(project).toFixed(1)}s, ${project.clips.length} clip(s), canvas ${project.canvas.width}x${project.canvas.height} fill=${project.canvas.fill}`);
  for (const p of placed.slice(0, 80)) {
    const c = p.clip;
    lines.push(`  ${c.id} ${c.asset} ${c.in.toFixed(2)}-${c.out.toFixed(2)}s → ${p.outStart.toFixed(2)}-${p.outEnd.toFixed(2)}s${c.zoom !== 1 ? ` zoom ${c.zoom}` : ""}${c.focusX !== 0.5 ? ` focusX ${c.focusX}` : ""}`);
  }
  if (placed.length > 80) lines.push(`  … ${placed.length - 80} more clips`);

  if (project.overlays.length) {
    lines.push("", "Overlays:");
    for (const o of project.overlays) {
      const s = resolveTime(o.start, "start", ctx, placed);
      const e = resolveTime(o.end, "end", ctx, placed);
      lines.push(`  ${o.id} ${o.asset} ${o.layout} ${s?.toFixed(2) ?? "?"}-${e?.toFixed(2) ?? "?"}s`);
    }
  }
  if (project.texts.length) {
    lines.push("", "Text:");
    for (const t of project.texts) {
      const s = resolveTime(t.start, "start", ctx, placed);
      const e = resolveTime(t.end, "end", ctx, placed);
      lines.push(`  ${t.id} "${t.text}" ${t.style}/${t.position} ${s?.toFixed(2) ?? "?"}-${e?.toFixed(2) ?? "?"}s`);
    }
  }
  const c = project.captions;
  lines.push("", `Captions: ${c.enabled ? `on, style ${c.style}, ${c.maxWords} words, ${c.position}` : "off"}`);
  if (project.audio.music) lines.push(`Music: ${project.audio.music.asset} at ${project.audio.music.volumeDb}dB${project.audio.music.duck ? ", ducked" : ""}`);
  if (project.brief) lines.push("", `Brief from the creator: ${project.brief}`);
  if (project.notes) lines.push("", `Notes: ${project.notes}`);

  const r = state.render;
  if (r.status !== "idle") {
    lines.push("", `Render: ${r.status}${r.status === "running" ? ` ${Math.round(r.progress * 100)}%` : ""}${r.output ? ` → ${join(ws.projects, id, r.output)}` : ""}${r.error ? ` — ${r.error}` : ""}`);
  }
  const renders = listRenders(ws, id);
  if (renders.length) lines.push(`Renders: ${renders.slice(0, 5).map((x) => x.file).join(", ")}`);
  const revs = listRevisions(ws, id);
  if (revs.length) lines.push(`Undo: revisions ${revs.slice(-8).join(", ")} available via revert.`);
  return lines.join("\n");
}

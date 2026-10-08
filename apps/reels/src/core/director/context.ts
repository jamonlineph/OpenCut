import { existsSync, readFileSync } from "node:fs";

import { readAnalysis } from "../analysis";
import { editContext, loadProject } from "../project";
import { contactSheet, grabFrames } from "../render/frames";
import type { Project } from "../schema";
import { listInbox } from "../service";
import { keptWordIds, placeClips, type EditContext, type PWord } from "../timeline";
import type { Workspace } from "../workspace";

export type Picture = { label: string; jpeg: Buffer };

/** Everything a director needs to understand a project. */
export type DirectorContext = {
  project: Project;
  ctx: EditContext;
  styleGuide: string;
  /** Plain-text facts: durations, framing, brief, available files. */
  facts: string;
  transcript: string;
  /** Frame grids of each source video, plus the images the creator provided. */
  pictures: Picture[];
  visuals: string[];
  music: string[];
};

/**
 * Transcript for an AI editor: every word carries its id, so it can choose exact
 * ranges. One line per sentence with its start time; fillers end in "*",
 * long pauses are marked, and words already cut are wrapped in ~~strikes~~.
 *
 *   (6.2s) 13|um,* 14|the 15|first 16|thing …
 */
export function directorTranscript(project: Project, ctx: EditContext, showCuts = false): string {
  const kept = showCuts ? keptWordIds(ctx, placeClips(project)) : null;
  const lines: string[] = [];
  let line: string[] = [];
  let prev: PWord | undefined;
  const flush = () => {
    if (line.length) lines.push(line.join(" "));
    line = [];
  };
  for (const w of ctx.words) {
    if (!prev || prev.asset !== w.asset) {
      flush();
      const a = project.assets.find((x) => x.id === w.asset);
      lines.push(`== ${w.asset}: ${a?.name ?? ""} ==`);
    } else if (w.start - prev.end >= 0.7) {
      flush();
      lines.push(`[pause ${(w.start - prev.end).toFixed(1)}s]`);
    }
    if (!line.length) line.push(`(${w.start.toFixed(1)}s)`);
    const token = `${w.id}|${w.text}${w.filler ? "*" : ""}`;
    line.push(kept && !kept.has(w.id) ? `~~${token}~~` : token);
    if (/[.?!]$/.test(w.text)) flush();
    prev = w;
  }
  flush();
  return lines.join("\n");
}

export async function gatherContext(ws: Workspace, projectId: string, options: { showCuts?: boolean; pictures?: boolean } = {}): Promise<DirectorContext> {
  const withPictures = options.pictures ?? true;
  const project = loadProject(ws, projectId);
  const ctx = editContext(ws, project);
  const inbox = listInbox(ws);
  const visuals = inbox.filter((i) => i.kind === "image" || (i.kind === "video" && i.file.startsWith("inbox/"))).map((i) => i.name);
  const music = inbox.filter((i) => i.kind === "audio").map((i) => i.name);

  // Images this reel is likely to use: ones already in the project, plus the
  // newest inbox images dropped alongside its videos.
  const projectFiles = new Set(project.assets.map((a) => a.file));
  const newestVideo = Math.max(
    0,
    ...inbox.filter((i) => projectFiles.has(i.file)).map((i) => Date.parse(i.modified)),
  );
  const relevantImages = inbox
    .filter((i) => i.kind === "image")
    .filter((i) => projectFiles.has(i.file) || Math.abs(Date.parse(i.modified) - newestVideo) < 15 * 60_000)
    .slice(0, 12);

  const pictures: Picture[] = [];
  const facts: string[] = [`Project id: ${project.id}`, `Canvas: ${project.canvas.width}x${project.canvas.height} vertical`];
  for (const asset of project.assets.filter((a) => a.kind === "video")) {
    const a = readAnalysis(ws, asset.file);
    if (!a.info) continue;
    const shape = a.info.width > a.info.height ? "wide (will be cropped to vertical)" : "vertical";
    facts.push(`Video ${asset.id} "${asset.name}": ${a.info.duration.toFixed(1)}s, ${a.info.width}x${a.info.height} ${shape}`);
    if (!withPictures) continue;
    const sheet = await contactSheet(a.source, a.info.duration, Math.max(1, a.info.duration / 12), 4);
    pictures.push({ label: `Frames from ${asset.name} at ${sheet.times.map((t) => `${t}s`).join(", ")} (left to right, top to bottom):`, jpeg: sheet.jpeg });
  }
  for (const img of withPictures ? relevantImages : []) {
    const a = readAnalysis(ws, img.file);
    try {
      const [frame] = await grabFrames(a.source, [0], 512);
      pictures.push({ label: `Image "${img.name}" provided by the creator:`, jpeg: frame!.jpeg });
    } catch {
      // Unreadable image: leave it out rather than fail the whole edit.
    }
  }

  if (project.brief) facts.push(`Creator's brief for this reel:\n${project.brief}`);
  const withDrop = (kind: "image" | "audio") => project.assets.filter((a) => a.kind === kind).map((a) => a.name);
  const others = (names: string[], dropped: string[]) => names.filter((n) => !dropped.includes(n));
  const droppedVisuals = withDrop("image");
  const droppedMusic = withDrop("audio");
  facts.push(`Images dropped with this video (use them where they fit): ${droppedVisuals.length ? droppedVisuals.join(", ") : "none"}`);
  facts.push(`Music dropped with this video: ${droppedMusic.length ? droppedMusic.join(", ") : "none - don't add music unless the style guide asks for it"}`);
  const library = [...others(visuals, droppedVisuals), ...others(music, droppedMusic)];
  if (library.length) facts.push(`Other files in the creator's library (only if clearly relevant): ${library.slice(0, 40).join(", ")}`);

  return {
    project,
    ctx,
    styleGuide: existsSync(ws.styleGuide) ? readFileSync(ws.styleGuide, "utf8") : "",
    facts: facts.join("\n"),
    transcript: directorTranscript(project, ctx, options.showCuts),
    pictures,
    visuals,
    music,
  };
}

export const SYSTEM_PROMPT = `You are the editor of a creator's short-form vertical videos (Reels, Shorts, TikTok). You get the transcript of their raw footage (every word has an id), frames from the footage, any images they provided, their notes, and their style guide. You decide the edit; software applies it exactly.

How to edit well:
- Understand what the video is about and who it is for before cutting. Use the creator's brief, notes and style guide.
- Keep complete thoughts. Segments start and end at sentence or clause boundaries, never mid-word.
- Remove false starts, repeated takes (keep the last clean one), tangents, "let me start again" and talk to the camera operator. Silences and um/uh are removed automatically after your cut, so don't fragment segments just to avoid them.
- Open with the strongest, most curiosity-provoking line (the hook) - move it to the front if it comes later. The reel must still make sense in order.
- End on a clear final line or the call to action.
- Respect the target length in the style guide. If the footage holds several self-contained ideas, make several reels (up to the limit given), each standing on its own.
- Pin images where the speaker talks about what they show; skip images that don't fit. Prefer layout "top" so the face stays visible.
- For wide footage, set focus_x to where the speaker's face is in the frames.
- Write the hook title and publish copy in the language the creator speaks, in their tone. If they mix languages (Taglish, Spanglish…), mirror the same mix.`;

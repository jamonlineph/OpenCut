import { z } from "zod";

import { OverlayLayout, type Project } from "../schema";
import { keptWords, outputToSource, placeClips, type EditContext } from "../timeline";
import type { EditOp } from "../ops";

// What an AI director decides for one reel. Deliberately small and flat so any
// model fills it reliably; code turns it into validated edit ops.

export const ReelPlan = z.object({
  name: z.string().describe("Short name for this reel, 2-5 words"),
  hook_title: z.string().describe("On-screen hook text for the first ~2.5 seconds, max 6 words. Empty string for none."),
  segments: z
    .array(z.object({ from: z.number().int(), to: z.number().int() }))
    .describe("Transcript word-id ranges to keep (inclusive), in the order they should play. Put the hook first. Each range should start and end at sentence or clause boundaries."),
  overlays: z
    .array(
      z.object({
        file: z.string().describe("Exact file name of one of the provided images or clips"),
        from: z.number().int().describe("Show from this word id"),
        to: z.number().int().describe("Hide after this word id"),
        layout: OverlayLayout,
      }),
    )
    .describe("Images/B-roll pinned to the words where the speaker talks about them. Empty if none fit."),
  caption_style: z.enum(["bold", "clean", "minimal"]),
  caption_position: z.enum(["lower", "middle", "upper"]),
  focus_x: z.number().describe("Horizontal position of the speaker's face in wide footage, 0 = left edge, 0.5 = center, 1 = right edge"),
  punch_in_zooms: z.boolean().describe("Alternate subtle zooms between cuts to hide jump cuts"),
  music: z.string().describe("File name of one of the provided music tracks, or empty string for none"),
  publish: z.object({
    title: z.string(),
    caption: z.string(),
    hashtags: z.array(z.string()),
  }),
});
export type ReelPlan = z.infer<typeof ReelPlan>;

export const DirectorPlan = z.object({
  summary: z.string().describe("What the footage is about, 1-2 sentences"),
  reels: z.array(ReelPlan).describe("One entry per reel to publish"),
});
export type DirectorPlan = z.infer<typeof DirectorPlan>;

export const ReviewResult = z.object({
  approved: z.boolean().describe("True if the reel is ready to publish as is"),
  problems: z.array(z.string()).describe("Concrete problems seen in the frames or the cut, empty if none"),
  revised: ReelPlan.describe("The plan to render: unchanged if approved, otherwise fixed"),
});
export type ReviewResult = z.infer<typeof ReviewResult>;

export type Available = { visuals: string[]; music: string[] };

export function formatPublish(p: ReelPlan["publish"]): string {
  const tags = p.hashtags.map((t) => (t.startsWith("#") ? t : `#${t.replace(/\s+/g, "")}`)).join(" ");
  return [`Title: ${p.title}`, `Caption: ${p.caption}`, tags && `Hashtags: ${tags}`].filter(Boolean).join("\n");
}

export function parsePublish(notes: string): ReelPlan["publish"] {
  const get = (key: string) => notes.match(new RegExp(`^${key}:\\s*(.*)$`, "mi"))?.[1]?.trim() ?? "";
  return { title: get("Title"), caption: get("Caption"), hashtags: get("Hashtags").split(/\s+/).filter(Boolean) };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Turns a plan into edit ops for `project`, dropping anything that doesn't fit. */
export function planToOps(plan: ReelPlan, project: Project, ctx: EditContext, available: Available): { ops: EditOp[]; warnings: string[] } {
  const warnings: string[] = [];
  const last = ctx.words.length - 1;
  const validWord = (id: number) => Number.isInteger(id) && id >= 0 && id <= last;
  const find = (list: string[], name: string) => list.find((f) => f.toLowerCase() === name.trim().toLowerCase());

  const ranges = plan.segments
    .filter((s) => validWord(s.from) && validWord(s.to))
    .map((s) => (s.from <= s.to ? s : { from: s.to, to: s.from }));
  if (ranges.length < plan.segments.length) warnings.push(`Dropped ${plan.segments.length - ranges.length} segment(s) with unknown word ids.`);
  if (!ranges.length) throw new Error("The plan kept no valid words.");

  const ops: EditOp[] = [
    ...project.overlays.map((o): EditOp => ({ op: "remove_overlay", id: o.id })),
    ...project.texts.map((t): EditOp => ({ op: "remove_text", id: t.id })),
    { op: "keep", ranges },
    { op: "remove_fillers" },
    { op: "remove_silences" },
    { op: "frame", focusX: clamp(Number.isFinite(plan.focus_x) ? plan.focus_x : 0.5, 0, 1) },
    { op: "auto_zoom", zoom: plan.punch_in_zooms ? 1.12 : 1 },
    { op: "captions", enabled: true, style: plan.caption_style, position: plan.caption_position },
  ];

  const title = plan.hook_title.trim();
  if (title) ops.push({ op: "add_text", text: title, start: 0, end: 2.5, style: "hook", position: "top" });

  for (const o of plan.overlays) {
    const file = find(available.visuals, o.file);
    if (!file) {
      warnings.push(`Skipped overlay "${o.file}": no such image or clip.`);
      continue;
    }
    if (!validWord(o.from) || !validWord(o.to)) {
      warnings.push(`Skipped overlay "${o.file}": unknown word ids.`);
      continue;
    }
    ops.push({ op: "add_overlay", asset: file, from: Math.min(o.from, o.to), to: Math.max(o.from, o.to), layout: o.layout });
  }

  const music = plan.music.trim() ? find(available.music, plan.music) : undefined;
  if (plan.music.trim() && !music) warnings.push(`Skipped music "${plan.music}": not found.`);
  ops.push({ op: "music", asset: music ?? null });
  ops.push({ op: "notes", text: formatPublish(plan.publish) });
  return { ops, warnings };
}

/** Describes a project's current edit as a plan, so an AI can revise it. */
export function projectToPlan(project: Project, ctx: EditContext): ReelPlan {
  const placed = placeClips(project);
  const kept = keptWords(ctx, placed);
  const segments: ReelPlan["segments"] = [];
  for (const w of kept) {
    const last = segments[segments.length - 1];
    if (last && w.id === last.to + 1) last.to = w.id;
    else segments.push({ from: w.id, to: w.id });
  }
  // Fillers inside a sentence were cut; bridge single-word gaps so segments read as phrases.
  const merged: ReelPlan["segments"] = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    const gap = last ? ctx.words.slice(last.to + 1, s.from) : [];
    if (last && s.from > last.to && gap.length > 0 && gap.every((w) => w.filler)) last.to = s.to;
    else merged.push({ ...s });
  }
  const wordAt = (ref: Project["overlays"][number]["start"], edge: "start" | "end") => {
    if (typeof ref !== "number") return ref.word;
    const hit = outputToSource(placed, ref);
    const words = kept.filter((w) => (edge === "start" ? w.outStart >= ref - 0.05 : w.outEnd <= ref + 0.05));
    if (!hit && !words.length) return kept[0]?.id ?? 0;
    return edge === "start" ? (words[0]?.id ?? kept.at(-1)?.id ?? 0) : (words.at(-1)?.id ?? kept[0]?.id ?? 0);
  };
  const assetName = (id: string) => project.assets.find((a) => a.id === id)?.name ?? id;
  const music = project.audio.music;
  return {
    name: project.name,
    hook_title: project.texts.find((t) => t.style === "hook")?.text ?? "",
    segments: merged,
    overlays: project.overlays.map((o) => ({ file: assetName(o.asset), from: wordAt(o.start, "start"), to: wordAt(o.end, "end"), layout: o.layout })),
    caption_style: project.captions.style,
    caption_position: project.captions.position,
    focus_x: project.clips[0]?.focusX ?? 0.5,
    punch_in_zooms: project.clips.some((c) => c.zoom > 1),
    music: music ? assetName(music.asset) : "",
    publish: parsePublish(project.notes),
  };
}

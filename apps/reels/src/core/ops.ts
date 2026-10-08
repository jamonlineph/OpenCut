import { z } from "zod";

import { round3, subtract, union, type Interval } from "./intervals";
import { addAsset, findAsset, fullClips } from "./project";
import { Captions, nextId, OverlayLayout, TextItem, TimeRef, type Clip, type Project } from "./schema";
import { findRetakes } from "./retakes";
import { clipDuration, keptWords, placeClips, totalDuration, type EditContext, type PWord } from "./timeline";
import type { Workspace } from "./workspace";

const WordRange = z.object({
  from: z.number().int().min(0).describe("First word id (inclusive)"),
  to: z.number().int().min(0).describe("Last word id (inclusive)"),
});

const Timing = {
  from: z.number().int().optional().describe("Start at this word id (follows the word through later cuts)"),
  to: z.number().int().optional().describe("End at this word id"),
  start: z.number().optional().describe("Or: start time in the finished reel, seconds"),
  end: z.number().optional().describe("Or: end time in the finished reel, seconds"),
};

export const EditOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("keep"), ranges: z.array(WordRange).min(1) }).describe(
    "Rebuild the reel from these word ranges, played in the order given. Everything else is dropped.",
  ),
  z.object({ op: z.literal("cut"), ...WordRange.shape }).describe("Cut words from..to (and the pause around them)."),
  z.object({ op: z.literal("restore"), ...WordRange.shape }).describe("Bring back words that were cut."),
  z.object({ op: z.literal("cut_time"), start: z.number(), end: z.number() }).describe(
    "Cut a span of the finished reel by output seconds (e.g. after inspecting a render).",
  ),
  z
    .object({
      op: z.literal("remove_silences"),
      minSilence: z.number().min(0.1).optional().describe("Only cut pauses at least this long (default 0.35s)"),
      padding: z.number().min(0).max(0.5).optional().describe("Breathing room kept at each cut (default 0.08s)"),
    })
    .describe("Jump-cut out every pause."),
  z.object({ op: z.literal("remove_fillers") }).describe("Cut um, uh, erm and similar."),
  z
    .object({ op: z.literal("remove_retakes") })
    .describe("Cut false starts and repeated takes, keeping the last attempt of each sentence."),
  z
    .object({ op: z.literal("move_to_start"), ...WordRange.shape, duplicate: z.boolean().optional() })
    .describe("Use words from..to as the hook: move them to the very start (duplicate=true keeps them in place too)."),
  z.object({ op: z.literal("reorder"), clipIds: z.array(z.string()).min(1) }).describe("Set the clip order."),
  z.object({ op: z.literal("delete_clip"), clipId: z.string() }),
  z
    .object({
      op: z.literal("set_clip"),
      clipId: z.string(),
      in: z.number().optional(),
      out: z.number().optional(),
      zoom: z.number().min(1).max(3).optional(),
      focusX: z.number().min(0).max(1).optional(),
      focusY: z.number().min(0).max(1).optional(),
    })
    .describe("Adjust one clip: trim (source seconds), zoom, or crop focus."),
  z
    .object({
      op: z.literal("auto_zoom"),
      zoom: z.number().min(1).max(2).optional().describe("Punch-in amount, default 1.12. Use 1 to remove zooms."),
    })
    .describe("Alternate normal and punched-in framing on every other clip to hide jump cuts."),
  z
    .object({
      op: z.literal("frame"),
      focusX: z.number().min(0).max(1).optional(),
      focusY: z.number().min(0).max(1).optional(),
      fill: z.enum(["crop", "blur"]).optional(),
    })
    .describe("Framing for all clips. focusX 0.5 centers the crop; fill=blur fits wide video over a blurred copy."),
  z
    .object({
      op: z.literal("add_overlay"),
      asset: z.string().describe("Inbox file name or asset id of an image or video"),
      ...Timing,
      layout: OverlayLayout.optional().describe("full | top (top half) | bottom | center (card) | pip (small corner)"),
      sourceStart: z.number().optional().describe("Video overlays: start this many seconds into the clip"),
    })
    .describe("Show an image or B-roll clip over the video."),
  z
    .object({
      op: z.literal("update_overlay"),
      id: z.string(),
      ...Timing,
      layout: OverlayLayout.optional(),
      fade: z.boolean().optional(),
    }),
  z.object({ op: z.literal("remove_overlay"), id: z.string() }),
  z
    .object({
      op: z.literal("add_text"),
      text: z.string().min(1),
      ...Timing,
      style: TextItem.shape.style.optional(),
      position: TextItem.shape.position.optional(),
    })
    .describe("On-screen title, e.g. the hook for the first 2-3 seconds."),
  z.object({
    op: z.literal("update_text"),
    id: z.string(),
    text: z.string().optional(),
    ...Timing,
    style: TextItem.shape.style.optional(),
    position: TextItem.shape.position.optional(),
  }),
  z.object({ op: z.literal("remove_text"), id: z.string() }),
  z.object({ op: z.literal("captions"), ...Captions.partial().shape }).describe("Change caption settings."),
  z
    .object({
      op: z.literal("music"),
      asset: z.string().nullable().describe("Music file (inbox or brand/music), or null to remove"),
      volumeDb: z.number().optional(),
      duck: z.boolean().optional(),
    })
    .describe("Background music, lowered automatically under speech."),
  z.object({ op: z.literal("notes"), text: z.string() }).describe("Save notes on the project (e.g. title, caption, hashtags)."),
  z.object({ op: z.literal("brief"), text: z.string() }).describe("Set the creator's context for this reel (topic, goal, audience, call to action)."),
  z.object({ op: z.literal("reset") }).describe("Start over with every video in full."),
]);
export type EditOp = z.infer<typeof EditOp>;

const MIN_PIECE = 0.1;

function word(ctx: EditContext, id: number): PWord {
  const w = ctx.words[id];
  if (!w) throw new Error(`Word #${id} does not exist (transcript has ${ctx.words.length} words).`);
  return w;
}

function neighbors(ctx: EditContext, w: PWord) {
  const prev = ctx.words[w.id - 1];
  const next = ctx.words[w.id + 1];
  return { prev: prev?.asset === w.asset ? prev : undefined, next: next?.asset === w.asset ? next : undefined };
}

/** Source span to keep for words from..to: their audio plus a little air, never reaching into the next word. */
function keepSpan(ctx: EditContext, from: PWord, to: PWord, pad: number): Interval {
  const { prev } = neighbors(ctx, from);
  const { next } = neighbors(ctx, to);
  const duration = ctx.assets.get(from.asset)?.duration ?? to.end + pad;
  const start = Math.max(from.start - pad, prev ? (prev.end + from.start) / 2 : 0, 0);
  const end = Math.min(to.end + pad, next ? (to.end + next.start) / 2 : duration, duration);
  return { start: round3(start), end: round3(end) };
}

/** Source span to remove for words from..to, including the pause around them, so the join is tight. */
function cutSpan(ctx: EditContext, from: PWord, to: PWord, pad: number): Interval {
  const { prev } = neighbors(ctx, from);
  const { next } = neighbors(ctx, to);
  const duration = ctx.assets.get(from.asset)?.duration ?? to.end;
  const start = prev ? Math.min(prev.end + pad, (prev.end + from.start) / 2) : 0;
  const end = next ? Math.max(next.start - pad, (to.end + next.start) / 2) : duration;
  return { start: round3(Math.min(start, from.start)), end: round3(Math.max(end, to.end)) };
}

function wordRange(ctx: EditContext, fromId: number, toId: number): [PWord, PWord][] {
  if (toId < fromId) [fromId, toId] = [toId, fromId];
  // A range may cross from one video into the next; split it per asset.
  const groups: [PWord, PWord][] = [];
  let first = word(ctx, fromId);
  let last = first;
  for (let id = fromId + 1; id <= toId; id++) {
    const w = word(ctx, id);
    if (w.asset !== first.asset) {
      groups.push([first, last]);
      first = w;
    }
    last = w;
  }
  groups.push([first, last]);
  return groups;
}

/** Removes a source interval from every clip of an asset, splitting clips as needed. */
function cutFromClips(project: Project, asset: string, cut: Interval, onlyClip?: string) {
  const next: Clip[] = [];
  for (const clip of project.clips) {
    if (clip.asset !== asset || (onlyClip && clip.id !== onlyClip)) {
      next.push(clip);
      continue;
    }
    const pieces = subtract({ start: clip.in, end: clip.out }, [cut]).filter((p) => p.end - p.start >= MIN_PIECE);
    pieces.forEach((p, i) =>
      next.push({ ...clip, id: i === 0 ? clip.id : nextId(project, "c"), in: round3(p.start), out: round3(p.end) }),
    );
  }
  project.clips = next;
}

/** Joins neighbouring clips that continue each other in the source. */
function mergeContinuous(project: Project) {
  const out: Clip[] = [];
  for (const clip of project.clips) {
    const last = out[out.length - 1];
    if (last && last.asset === clip.asset && last.zoom === clip.zoom && last.focusX === clip.focusX &&
        last.focusY === clip.focusY && clip.in >= last.in && clip.in <= last.out + 0.001) {
      last.out = Math.max(last.out, clip.out);
    } else out.push({ ...clip });
  }
  project.clips = out;
}

/** A word-anchored item with no end lasts about `seconds`, ending on a word boundary. */
function defaultEnd(start: TimeRef, seconds: number, ctx: EditContext): TimeRef {
  if (typeof start === "number") return start + seconds;
  const first = word(ctx, start.word);
  let last = first;
  for (let id = first.id + 1; id < ctx.words.length; id++) {
    const w = ctx.words[id]!;
    if (w.asset !== first.asset || w.start > first.start + seconds) break;
    last = w;
  }
  return { word: last.id, edge: "end" };
}

function timing(args: { from?: number; to?: number; start?: number; end?: number }, ctx: EditContext) {
  const start: TimeRef | undefined = args.from !== undefined ? { word: word(ctx, args.from).id } : args.start;
  const end: TimeRef | undefined = args.to !== undefined ? { word: word(ctx, args.to).id } : args.end;
  return { start, end };
}

function find<T extends { id: string }>(items: T[], id: string, what: string): T {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`${what} "${id}" not found.`);
  return item;
}

export type EditResult = { project: Project; summary: string[] };

export function applyEdits(ws: Workspace, input: Project, ops: EditOp[], ctx: EditContext, settings: { minSilence: number; cutPadding: number }): EditResult {
  const project: Project = structuredClone(input);
  const summary: string[] = [];
  const before = totalDuration(project);

  for (const op of ops) {
    switch (op.op) {
      case "keep": {
        const clips: Clip[] = [];
        for (const range of op.ranges) {
          for (const [from, to] of wordRange(ctx, range.from, range.to)) {
            const span = keepSpan(ctx, from, to, settings.cutPadding);
            clips.push({ id: nextId(project, "c"), asset: from.asset, in: span.start, out: span.end, zoom: 1, focusX: 0.5, focusY: 0.5 });
          }
        }
        project.clips = clips;
        mergeContinuous(project);
        summary.push(`Kept ${op.ranges.length} word range(s).`);
        break;
      }
      case "cut": {
        for (const [from, to] of wordRange(ctx, op.from, op.to)) {
          cutFromClips(project, from.asset, cutSpan(ctx, from, to, settings.cutPadding));
        }
        summary.push(`Cut words #${op.from}-#${op.to}.`);
        break;
      }
      case "restore": {
        for (const [from, to] of wordRange(ctx, op.from, op.to)) {
          const span = keepSpan(ctx, from, to, settings.cutPadding);
          // Put it back after the last clip that starts before it in the source.
          let at = -1;
          for (let i = project.clips.length - 1; i >= 0 && at === -1; i--) {
            const c = project.clips[i]!;
            if (c.asset === from.asset && c.in <= span.start) at = i + 1;
          }
          if (at === -1) {
            const first = project.clips.findIndex((c) => c.asset === from.asset);
            at = first === -1 ? project.clips.length : first;
          }
          const ref = project.clips[Math.max(0, at - 1)];
          project.clips.splice(at, 0, {
            id: nextId(project, "c"), asset: from.asset, in: span.start, out: span.end,
            zoom: ref?.zoom ?? 1, focusX: ref?.focusX ?? 0.5, focusY: ref?.focusY ?? 0.5,
          });
        }
        mergeContinuous(project);
        summary.push(`Restored words #${op.from}-#${op.to}.`);
        break;
      }
      case "cut_time": {
        const placed = placeClips(project);
        for (const p of placed) {
          const s = Math.max(op.start, p.outStart);
          const e = Math.min(op.end, p.outEnd);
          if (e <= s) continue;
          cutFromClips(project, p.clip.asset, { start: p.clip.in + (s - p.outStart), end: p.clip.in + (e - p.outStart) }, p.clip.id);
        }
        summary.push(`Cut ${op.start.toFixed(2)}s-${op.end.toFixed(2)}s of the reel.`);
        break;
      }
      case "remove_silences": {
        const min = op.minSilence ?? settings.minSilence;
        const pad = op.padding ?? settings.cutPadding;
        const count = project.clips.length;
        const next: Clip[] = [];
        for (const clip of project.clips) {
          const data = ctx.assets.get(clip.asset);
          // Wordless sound before the first or after the last word (a breath, reaching
          // for the camera) goes too. Mid-video it might be a mistimed word, so it stays.
          const spoken = ctx.words.filter((w) => w.asset === clip.asset);
          const firstWord = spoken[0]?.start ?? Infinity;
          const lastWord = spoken[spoken.length - 1]?.end ?? -Infinity;
          const noise = (data?.noise ?? []).filter((n) => n.end <= firstWord + 0.01 || n.start >= lastWord - 0.01);
          const silences = [...(data?.silences ?? []).filter((s) => s.end - s.start >= min), ...noise]
            // Keep a little air at each side, except at the very start/end of a clip.
            .map((s) => ({ start: s.start <= clip.in ? s.start : s.start + pad, end: s.end >= clip.out ? s.end : s.end - pad }));
          subtract({ start: clip.in, end: clip.out }, union(silences))
            .filter((p) => p.end - p.start >= MIN_PIECE)
            .forEach((p, i) => next.push({ ...clip, id: i === 0 ? clip.id : nextId(project, "c"), in: round3(p.start), out: round3(p.end) }));
        }
        project.clips = next;
        summary.push(`Removed silences ≥${min}s (${count} → ${project.clips.length} clips).`);
        break;
      }
      case "remove_fillers": {
        const placedIds = new Set<number>();
        for (const p of placeClips(project)) {
          for (const w of ctx.words) if (w.asset === p.clip.asset && w.filler && w.start >= p.clip.in && w.end <= p.clip.out) placedIds.add(w.id);
        }
        // Cut runs of consecutive fillers together ("um, uh").
        const ids = [...placedIds].sort((a, b) => a - b);
        const runs: [number, number][] = [];
        for (const id of ids) {
          const last = runs[runs.length - 1];
          if (last && last[1] === id - 1) last[1] = id;
          else runs.push([id, id]);
        }
        let skipped = 0;
        for (const [a, b] of runs) {
          const from = word(ctx, a);
          const to = word(ctx, b);
          // A filler said without any pause around it has guessed timing; cutting it
          // could clip the next word, so leave it (captions hide it anyway).
          const { prev } = neighbors(ctx, from);
          const { next } = neighbors(ctx, to);
          const pauseBefore = !prev || from.start - prev.end >= 0.08;
          const pauseAfter = !next || next.start - to.end >= 0.08;
          if (!pauseBefore && !pauseAfter) {
            skipped += b - a + 1;
            continue;
          }
          cutFromClips(project, from.asset, cutSpan(ctx, from, to, settings.cutPadding));
        }
        summary.push(`Removed ${ids.length - skipped} filler word(s)${skipped ? ` (left ${skipped} said without a pause)` : ""}.`);
        break;
      }
      case "remove_retakes": {
        const ranges = findRetakes(keptWords(ctx, placeClips(project)));
        for (const [a, b] of ranges) {
          for (const [from, to] of wordRange(ctx, a, b)) cutFromClips(project, from.asset, cutSpan(ctx, from, to, settings.cutPadding));
        }
        summary.push(ranges.length ? `Removed ${ranges.length} false start(s)/retake(s): ${ranges.map(([a, b]) => `#${a}-#${b}`).join(", ")}.` : "No retakes found.");
        break;
      }
      case "move_to_start": {
        const groups = wordRange(ctx, op.from, op.to);
        if (!op.duplicate) for (const [from, to] of groups) cutFromClips(project, from.asset, cutSpan(ctx, from, to, settings.cutPadding));
        const hook = groups.map(([from, to]) => {
          const span = keepSpan(ctx, from, to, settings.cutPadding);
          return { id: nextId(project, "c"), asset: from.asset, in: span.start, out: span.end, zoom: 1, focusX: project.clips[0]?.focusX ?? 0.5, focusY: project.clips[0]?.focusY ?? 0.5 };
        });
        project.clips.unshift(...hook);
        summary.push(`Moved words #${op.from}-#${op.to} to the start as the hook.`);
        break;
      }
      case "reorder": {
        const byId = new Map(project.clips.map((c) => [c.id, c]));
        const missing = project.clips.filter((c) => !op.clipIds.includes(c.id)).map((c) => c.id);
        const reordered = op.clipIds.map((id) => {
          const c = byId.get(id);
          if (!c) throw new Error(`Clip "${id}" not found.`);
          return c;
        });
        project.clips = [...reordered, ...missing.map((id) => byId.get(id)!)];
        summary.push(`Reordered clips${missing.length ? ` (${missing.join(", ")} kept at the end)` : ""}.`);
        break;
      }
      case "delete_clip": {
        find(project.clips, op.clipId, "Clip");
        project.clips = project.clips.filter((c) => c.id !== op.clipId);
        summary.push(`Deleted clip ${op.clipId}.`);
        break;
      }
      case "set_clip": {
        const clip = find(project.clips, op.clipId, "Clip");
        const duration = ctx.assets.get(clip.asset)?.duration ?? Infinity;
        if (op.in !== undefined) clip.in = round3(Math.max(0, op.in));
        if (op.out !== undefined) clip.out = round3(Math.min(duration, op.out));
        if (clip.out - clip.in < MIN_PIECE) throw new Error(`Clip ${clip.id} would be too short.`);
        if (op.zoom !== undefined) clip.zoom = op.zoom;
        if (op.focusX !== undefined) clip.focusX = op.focusX;
        if (op.focusY !== undefined) clip.focusY = op.focusY;
        summary.push(`Updated clip ${clip.id}.`);
        break;
      }
      case "auto_zoom": {
        const zoom = op.zoom ?? 1.12;
        project.clips.forEach((c, i) => (c.zoom = i % 2 === 1 ? zoom : 1));
        summary.push(zoom === 1 ? "Removed zooms." : `Alternating ${zoom}x punch-ins.`);
        break;
      }
      case "frame": {
        for (const c of project.clips) {
          if (op.focusX !== undefined) c.focusX = op.focusX;
          if (op.focusY !== undefined) c.focusY = op.focusY;
        }
        if (op.fill) project.canvas.fill = op.fill;
        summary.push("Updated framing.");
        break;
      }
      case "add_overlay": {
        const asset = addAsset(ws, project, op.asset);
        if (asset.kind === "audio") throw new Error("Use the music op for audio files.");
        let { start, end } = timing(op, ctx);
        start ??= 0;
        end ??= defaultEnd(start, 3, ctx);
        const id = nextId(project, "o");
        project.overlays.push({ id, asset: asset.id, start, end, layout: op.layout ?? "top", fade: true, sourceStart: op.sourceStart ?? 0 });
        summary.push(`Added overlay ${id} (${asset.name}, ${op.layout ?? "top"}).`);
        break;
      }
      case "update_overlay": {
        const o = find(project.overlays, op.id, "Overlay");
        const { start, end } = timing(op, ctx);
        if (start !== undefined) o.start = start;
        if (end !== undefined) o.end = end;
        if (op.layout) o.layout = op.layout;
        if (op.fade !== undefined) o.fade = op.fade;
        summary.push(`Updated overlay ${o.id}.`);
        break;
      }
      case "remove_overlay": {
        find(project.overlays, op.id, "Overlay");
        project.overlays = project.overlays.filter((o) => o.id !== op.id);
        summary.push(`Removed overlay ${op.id}.`);
        break;
      }
      case "add_text": {
        let { start, end } = timing(op, ctx);
        start ??= 0;
        end ??= defaultEnd(start, 2.5, ctx);
        const id = nextId(project, "t");
        project.texts.push({ id, text: op.text, start, end, style: op.style ?? "hook", position: op.position ?? "top" });
        summary.push(`Added text ${id}: "${op.text}".`);
        break;
      }
      case "update_text": {
        const t = find(project.texts, op.id, "Text");
        const { start, end } = timing(op, ctx);
        if (op.text) t.text = op.text;
        if (start !== undefined) t.start = start;
        if (end !== undefined) t.end = end;
        if (op.style) t.style = op.style;
        if (op.position) t.position = op.position;
        summary.push(`Updated text ${t.id}.`);
        break;
      }
      case "remove_text": {
        find(project.texts, op.id, "Text");
        project.texts = project.texts.filter((t) => t.id !== op.id);
        summary.push(`Removed text ${op.id}.`);
        break;
      }
      case "captions": {
        const { op: _op, ...patch } = op;
        project.captions = Captions.parse({ ...project.captions, ...patch });
        summary.push("Updated captions.");
        break;
      }
      case "music": {
        if (op.asset === null) {
          project.audio.music = null;
          summary.push("Removed music.");
          break;
        }
        const asset = addAsset(ws, project, op.asset);
        if (asset.kind !== "audio") throw new Error(`${asset.name} is not an audio file.`);
        project.audio.music = { asset: asset.id, volumeDb: op.volumeDb ?? project.audio.music?.volumeDb ?? -20, duck: op.duck ?? true };
        summary.push(`Music: ${asset.name}.`);
        break;
      }
      case "brief": {
        project.brief = op.text;
        summary.push("Saved brief.");
        break;
      }
      case "notes": {
        project.notes = op.text;
        summary.push("Saved notes.");
        break;
      }
      case "reset": {
        project.clips = fullClips(project, ctx);
        summary.push("Reset to the full, uncut videos.");
        break;
      }
    }
  }

  project.clips = project.clips.filter((c) => clipDuration(c) >= MIN_PIECE);
  for (const o of project.overlays) findAsset(project, o.asset);
  const after = totalDuration(project);
  summary.push(`Duration ${before.toFixed(1)}s → ${after.toFixed(1)}s, ${project.clips.length} clip(s).`);
  return { project, summary };
}


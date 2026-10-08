import type { Interval } from "./intervals";
import type { Clip, Project, TimeRef } from "./schema";

/** A transcript word with a project-wide id, in source time. */
export type PWord = {
  id: number;
  asset: string;
  text: string;
  start: number;
  end: number;
  filler?: boolean;
  /** Timing inferred from the audio because Whisper's was off. */
  guessed?: boolean;
};

/** Per-asset analysis data the timeline needs. */
export type AssetData = {
  /** Probed and ready to render. */
  ready: boolean;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Has an audio track that isn't digital silence. */
  audible: boolean;
  hdr: boolean;
  silences: Interval[];
  /** Sound with no words in it (breaths, clicks, room noise). */
  noise: Interval[];
  /** Absolute path to decode when rendering. */
  source: string;
};

export type EditContext = {
  words: PWord[];
  assets: Map<string, AssetData>;
};

export type PlacedClip = { clip: Clip; index: number; outStart: number; outEnd: number };

export const clipDuration = (c: Clip) => Math.max(0, c.out - c.in);

/** Snap clip lengths to whole frames so audio and video stay in sync after concat. */
export function frameSnap(clip: Clip, fps: number): Clip {
  const frames = Math.max(1, Math.round((clip.out - clip.in) * fps));
  return { ...clip, out: clip.in + frames / fps };
}

export function placeClips(project: Project): PlacedClip[] {
  let t = 0;
  return project.clips.map((clip, index) => {
    const d = Math.round(clipDuration(clip) * project.canvas.fps) / project.canvas.fps;
    const placed = { clip, index, outStart: t, outEnd: t + d };
    t += d;
    return placed;
  });
}

export function totalDuration(project: Project): number {
  const placed = placeClips(project);
  return placed.length ? placed[placed.length - 1]!.outEnd : 0;
}

/**
 * Where source time `t` of `asset` lands in the reel. If that moment was cut,
 * "start" snaps forward to the next kept moment and "end" snaps back.
 */
export function sourceToOutput(placed: PlacedClip[], asset: string, t: number, edge: "start" | "end"): number | null {
  const inside = placed.find((p) => p.clip.asset === asset && t >= p.clip.in && t <= p.clip.out);
  if (inside) return inside.outStart + (t - inside.clip.in);
  const sameAsset = placed.filter((p) => p.clip.asset === asset);
  if (edge === "start") {
    const next = sameAsset.filter((p) => p.clip.in > t).sort((a, b) => a.clip.in - b.clip.in)[0];
    return next ? next.outStart : null;
  }
  const prev = sameAsset.filter((p) => p.clip.out < t).sort((a, b) => b.clip.out - a.clip.out)[0];
  return prev ? prev.outEnd : null;
}

export function outputToSource(placed: PlacedClip[], t: number): { placed: PlacedClip; time: number } | null {
  const p = placed.find((p) => t >= p.outStart && t < p.outEnd) ?? (t === placed.at(-1)?.outEnd ? placed.at(-1) : undefined);
  return p ? { placed: p, time: p.clip.in + (t - p.outStart) } : null;
}

export function resolveTime(ref: TimeRef, edge: "start" | "end", ctx: EditContext, placed: PlacedClip[]): number | null {
  if (typeof ref === "number") return ref;
  const word = ctx.words[ref.word];
  if (!word) return null;
  const useEdge = ref.edge ?? edge;
  return sourceToOutput(placed, word.asset, useEdge === "start" ? word.start : word.end, useEdge);
}

export type TimedWord = PWord & { outStart: number; outEnd: number; clipIndex: number };

/** Words that survive the edit, in the order they play, with output times. */
export function keptWords(ctx: EditContext, placed: PlacedClip[]): TimedWord[] {
  const out: TimedWord[] = [];
  for (const p of placed) {
    for (const w of ctx.words) {
      if (w.asset !== p.clip.asset) continue;
      const mid = (w.start + w.end) / 2;
      if (mid < p.clip.in || mid > p.clip.out) continue;
      out.push({
        ...w,
        outStart: Math.max(p.outStart, p.outStart + (w.start - p.clip.in)),
        outEnd: Math.min(p.outEnd, p.outStart + (w.end - p.clip.in)),
        clipIndex: p.index,
      });
    }
  }
  return out;
}

export function keptWordIds(ctx: EditContext, placed: PlacedClip[]): Set<number> {
  return new Set(keptWords(ctx, placed).map((w) => w.id));
}

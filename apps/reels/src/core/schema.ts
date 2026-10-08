import { z } from "zod";

/**
 * A point in the finished reel: output seconds, or a transcript word
 * (by its global id) that follows the word wherever later cuts move it.
 */
export const TimeRef = z.union([
  z.number().min(0),
  z.object({ word: z.number().int().min(0), edge: z.enum(["start", "end"]).optional() }),
]);
export type TimeRef = z.infer<typeof TimeRef>;

export const Asset = z.object({
  id: z.string(),
  kind: z.enum(["video", "image", "audio"]),
  /** Path relative to the workspace root, e.g. "inbox/talk.mp4". */
  file: z.string(),
  name: z.string(),
});
export type Asset = z.infer<typeof Asset>;

export const Clip = z.object({
  id: z.string(),
  asset: z.string(),
  /** Source in/out points in seconds. */
  in: z.number().min(0),
  out: z.number().min(0),
  /** 1 = no zoom. 1.1-1.2 is a subtle punch-in. */
  zoom: z.number().min(1).max(3).default(1),
  /** Where to center the vertical crop, 0 = left/top, 1 = right/bottom. */
  focusX: z.number().min(0).max(1).default(0.5),
  focusY: z.number().min(0).max(1).default(0.5),
});
export type Clip = z.infer<typeof Clip>;

export const OverlayLayout = z.enum(["full", "top", "bottom", "center", "pip"]);
export type OverlayLayout = z.infer<typeof OverlayLayout>;

export const Overlay = z.object({
  id: z.string(),
  asset: z.string(),
  start: TimeRef,
  end: TimeRef,
  layout: OverlayLayout.default("top"),
  fade: z.boolean().default(true),
  /** For video overlays: where to start reading the source, in seconds. */
  sourceStart: z.number().min(0).default(0),
});
export type Overlay = z.infer<typeof Overlay>;

export const TextItem = z.object({
  id: z.string(),
  text: z.string().min(1),
  start: TimeRef,
  end: TimeRef,
  style: z.enum(["hook", "label"]).default("hook"),
  position: z.enum(["top", "center", "bottom"]).default("top"),
});
export type TextItem = z.infer<typeof TextItem>;

export const Captions = z.object({
  enabled: z.boolean().default(true),
  style: z.enum(["bold", "clean", "minimal"]).default("bold"),
  maxWords: z.number().int().min(1).max(12).default(3),
  position: z.enum(["lower", "middle", "upper"]).default("lower"),
  highlight: z.boolean().default(true),
  uppercase: z.boolean().optional(),
  /** Hex colors like "#FFFFFF". */
  color: z.string().optional(),
  highlightColor: z.string().optional(),
  font: z.string().optional(),
  fontSize: z.number().min(20).max(200).optional(),
});
export type Captions = z.infer<typeof Captions>;

export const Music = z.object({
  asset: z.string(),
  volumeDb: z.number().min(-60).max(6).default(-20),
  /** Lower the music while you talk. */
  duck: z.boolean().default(true),
});

export const Canvas = z.object({
  width: z.number().int().default(1080),
  height: z.number().int().default(1920),
  fps: z.number().default(30),
  /** crop = fill the frame; blur = fit the video over a blurred copy. */
  fill: z.enum(["crop", "blur"]).default("crop"),
});

export const Project = z.object({
  version: z.literal(1).default(1),
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().default(0),
  /** Counter for short ids like c12, o3. */
  seq: z.number().int().default(0),
  canvas: Canvas.default(Canvas.parse({})),
  assets: z.array(Asset).default([]),
  clips: z.array(Clip).default([]),
  overlays: z.array(Overlay).default([]),
  texts: z.array(TextItem).default([]),
  captions: Captions.default(Captions.parse({})),
  audio: z
    .object({
      music: Music.nullable().default(null),
      normalize: z.boolean().default(true),
      targetLufs: z.number().default(-14),
    })
    .default({ music: null, normalize: true, targetLufs: -14 }),
  /** What the creator says this reel is about: goal, audience, call to action. Read by the AI. */
  brief: z.string().default(""),
  /** Free-form notes, e.g. the agent's publish copy or what it changed. */
  notes: z.string().default(""),
});
export type Project = z.infer<typeof Project>;

export function nextId(project: Project, prefix: string): string {
  project.seq += 1;
  return `${prefix}${project.seq}`;
}

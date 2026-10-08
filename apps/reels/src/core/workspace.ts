import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { DEFAULT_STYLE_GUIDE } from "./style-guide";

export const MEDIA_EXTENSIONS = {
  video: [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"],
  image: [".jpg", ".jpeg", ".png", ".webp", ".heic", ".gif"],
  audio: [".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg"],
} as const;

export type MediaKind = keyof typeof MEDIA_EXTENSIONS;

export function mediaKindOf(file: string): MediaKind | null {
  const lower = file.toLowerCase();
  for (const kind of Object.keys(MEDIA_EXTENSIONS) as MediaKind[]) {
    if (MEDIA_EXTENSIONS[kind].some((ext) => lower.endsWith(ext))) return kind;
  }
  return null;
}

export const Settings = z.object({
  /** whisper.cpp model file name inside `models/`. */
  whisperModel: z.string().default("ggml-large-v3-turbo-q5_0.bin"),
  /** Spoken language code (en, es, tl, ...) or "auto". */
  language: z.string().default("auto"),
  /** Video encoder: auto picks libx264, then VideoToolbox. */
  encoder: z.enum(["auto", "libx264", "h264_videotoolbox"]).default("auto"),
  /** Silences shorter than this are kept (seconds). */
  minSilence: z.number().default(0.35),
  /** Padding kept around speech at each cut (seconds). */
  cutPadding: z.number().default(0.08),
  captionStyle: z.enum(["bold", "clean", "minimal"]).default("bold"),
});
export type Settings = z.infer<typeof Settings>;

export type Workspace = {
  root: string;
  inbox: string;
  projects: string;
  cache: string;
  models: string;
  fonts: string;
  music: string;
  settingsFile: string;
  styleGuide: string;
};

export function defaultRoot(): string {
  return process.env.OPENCUT_WORKSPACE
    ? resolve(process.env.OPENCUT_WORKSPACE)
    : join(homedir(), "Movies", "OpenCut");
}

let cached: Workspace | null = null;

export function workspace(root = defaultRoot()): Workspace {
  if (cached && cached.root === root) return cached;
  const ws: Workspace = {
    root,
    inbox: join(root, "inbox"),
    projects: join(root, "projects"),
    cache: join(root, ".cache"),
    models: join(root, "models"),
    fonts: join(root, "brand", "fonts"),
    music: join(root, "brand", "music"),
    settingsFile: join(root, "settings.json"),
    styleGuide: join(root, "STYLE.md"),
  };
  for (const dir of [ws.inbox, ws.projects, ws.cache, ws.models, ws.fonts, ws.music]) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(ws.settingsFile)) writeJson(ws.settingsFile, Settings.parse({}));
  if (!existsSync(ws.styleGuide)) writeFileSync(ws.styleGuide, DEFAULT_STYLE_GUIDE);
  cached = ws;
  return ws;
}

export function readSettings(ws: Workspace): Settings {
  try {
    return Settings.parse(JSON.parse(readFileSync(ws.settingsFile, "utf8")));
  } catch {
    return Settings.parse({});
  }
}

export function writeSettings(ws: Workspace, patch: Partial<Settings>): Settings {
  const next = Settings.parse({ ...readSettings(ws), ...patch });
  writeJson(ws.settingsFile, next);
  return next;
}

/** Atomic write so a reader in another process never sees half a file. */
export function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function slugify(text: string): string {
  return (
    text
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "reel"
  );
}

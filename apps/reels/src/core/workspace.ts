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
  autopilot: z
    .object({
      /** Who decides the edit for dropped videos. "auto" picks the best one available. */
      director: z.enum(["auto", "claude-code", "claude-api", "codex", "basic"]).default("auto"),
      /** Claude model for the claude-api director. */
      model: z.string().default("claude-opus-5-5"),
      /** Most reels to cut from one long video. */
      maxReels: z.number().int().min(1).max(10).default(3),
      /** Let the AI watch its preview render and fix problems before the final render. */
      review: z.boolean().default(true),
      /** Wait for your OK in the Studio (with a quick preview) before exporting to the outbox. */
      approve: z.boolean().default(true),
      /** macOS notification when a reel is ready. */
      notify: z.boolean().default(true),
      /** POST a JSON summary here when a reel is ready (Make, Zapier, n8n, Monday.com…). */
      webhookUrl: z.string().default(""),
      /** Override the headless agent command. "{prompt}" and "{mcpConfig}" are filled in. */
      agentCommand: z.array(z.string()).default([]),
      /** Minutes before a headless agent run is stopped. */
      agentTimeoutMinutes: z.number().min(1).default(40),
    })
    .prefault({}),
});
export type Settings = z.infer<typeof Settings>;
export type AutopilotSettings = Settings["autopilot"];

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
  /** Drop folder: anything put here is edited automatically. */
  autoEdit: string;
  /** Finished reels and their publish copy. */
  outbox: string;
  /** Autopilot job records and runtime files. */
  autopilot: string;
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
    autoEdit: join(root, "auto-edit"),
    outbox: join(root, "outbox"),
    autopilot: join(root, ".autopilot"),
  };
  for (const dir of [ws.inbox, ws.projects, ws.cache, ws.models, ws.fonts, ws.music, ws.autoEdit, ws.outbox, ws.autopilot]) {
    mkdirSync(dir, { recursive: true });
  }
  // Write missing options into settings.json so they're visible and editable,
  // but never overwrite a file the user broke while editing.
  const raw = readJson<unknown>(ws.settingsFile);
  const parsed = Settings.safeParse(raw ?? {});
  if (!existsSync(ws.settingsFile) || (parsed.success && JSON.stringify(parsed.data) !== JSON.stringify(raw))) {
    if (parsed.success) writeJson(ws.settingsFile, parsed.data);
  }
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

export function writeSettings(ws: Workspace, patch: Partial<Omit<Settings, "autopilot">> & { autopilot?: Partial<AutopilotSettings> }): Settings {
  const current = readSettings(ws);
  const next = Settings.parse({ ...current, ...patch, autopilot: { ...current.autopilot, ...patch.autopilot } });
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

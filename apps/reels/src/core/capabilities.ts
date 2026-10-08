import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ffmpegBin, isBundled, run, which } from "./exec";
import { whisperBin } from "./transcribe";
import { readSettings, type Workspace } from "./workspace";

export type Capabilities = {
  ffmpeg: string;
  version: string;
  captions: boolean;
  libx264: boolean;
  videotoolbox: boolean;
  tonemap: boolean;
};

let cached: Capabilities | null = null;

export async function capabilities(): Promise<Capabilities> {
  if (cached) return cached;
  const bin = ffmpegBin();
  const [version, filters, encoders] = await Promise.all([
    run([bin, "-hide_banner", "-version"]),
    run([bin, "-hide_banner", "-filters"]),
    run([bin, "-hide_banner", "-encoders"]),
  ]);
  const has = (text: string, name: string) => new RegExp(`\\s${name}\\s`).test(text);
  cached = {
    ffmpeg: bin,
    version: version.stdout.split("\n")[0]?.replace("ffmpeg version ", "").split(" ")[0] ?? "?",
    captions: has(filters.stdout, "ass"),
    libx264: has(encoders.stdout, "libx264"),
    videotoolbox: has(encoders.stdout, "h264_videotoolbox"),
    tonemap: has(filters.stdout, "zscale") && has(filters.stdout, "tonemap"),
  };
  return cached;
}

export async function pickEncoder(ws: Workspace): Promise<"libx264" | "h264_videotoolbox"> {
  const caps = await capabilities();
  const wanted = readSettings(ws).encoder;
  if (wanted === "libx264" && caps.libx264) return "libx264";
  if (wanted === "h264_videotoolbox" && caps.videotoolbox) return "h264_videotoolbox";
  if (caps.libx264) return "libx264";
  if (caps.videotoolbox) return "h264_videotoolbox";
  throw new Error("This FFmpeg has no H.264 encoder. Install the full build: brew install ffmpeg");
}

export type Check = { name: string; ok: boolean; detail: string; fix?: string };

export async function doctor(ws: Workspace): Promise<Check[]> {
  const checks: Check[] = [];
  let caps: Capabilities | null = null;
  try {
    caps = await capabilities();
    checks.push({ name: "FFmpeg", ok: true, detail: isBundled(caps.ffmpeg) ? `${caps.version} (built into OpenCut)` : `${caps.version} at ${caps.ffmpeg}` });
  } catch (e) {
    checks.push({ name: "FFmpeg", ok: false, detail: String((e as Error).message), fix: "brew install ffmpeg" });
  }
  if (caps) {
    checks.push({
      name: "Captions",
      ok: true,
      detail: caps.captions ? "libass (animated)" : "built-in renderer (this FFmpeg has no libass, which is fine)",
    });
    const enc = caps.libx264 ? "libx264" : caps.videotoolbox ? "VideoToolbox" : "none";
    checks.push({ name: "H.264 encoder", ok: enc !== "none", detail: enc, fix: enc === "none" ? "brew install ffmpeg" : undefined });
    checks.push({ name: "HDR (iPhone) footage", ok: true, detail: caps.tonemap ? "exact tone mapping (zimg)" : "approximate color conversion (fine for most clips)" });
  }
  const whisper = whisperBin();
  checks.push({ name: "whisper.cpp", ok: Boolean(whisper), detail: isBundled(whisper) ? "built into OpenCut" : (whisper ?? "not found"), fix: whisper ? undefined : "brew install whisper-cpp" });
  const model = join(ws.models, readSettings(ws).whisperModel);
  checks.push({ name: "Whisper model", ok: existsSync(model), detail: existsSync(model) ? model : `missing: ${model}`, fix: existsSync(model) ? undefined : "bun run setup" });
  const fonts = existsSync(ws.fonts) ? readdirSync(ws.fonts).filter((f) => /\.(ttf|otf)$/i.test(f)) : [];
  checks.push({ name: "Brand fonts", ok: true, detail: fonts.length ? fonts.join(", ") : `none (optional: put .ttf/.otf files in ${ws.fonts})` });
  checks.push({ name: "macOS image conversion (sips)", ok: true, detail: which("sips") ? "available (HEIC photos supported)" : "not available (use JPEG/PNG photos)" });
  return checks;
}

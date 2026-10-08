import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { ffmpegBin, runOrThrow, which } from "./exec";
import { probe, type MediaInfo } from "./probe";
import { detectSilences, type SilenceAnalysis } from "./silence";
import { alignToSpeech } from "./align";
import { extractSpeechAudio, transcribe, type Transcript } from "./transcribe";
import { mediaKindOf, readJson, readSettings, writeJson, type Workspace } from "./workspace";

export type AnalysisStage = "queued" | "probing" | "audio" | "silences" | "transcribing" | "done" | "error";

export type AnalysisStatus = {
  stage: AnalysisStage;
  /** 0..1 within the whole analysis. */
  progress: number;
  error?: string;
  updatedAt: string;
};

export type MediaAnalysis = {
  file: string;
  info: MediaInfo | null;
  /** File to decode when rendering (HEIC photos are converted to JPEG). */
  source: string;
  thumb: string | null;
  transcript: Transcript | null;
  silence: SilenceAnalysis | null;
  status: AnalysisStatus | null;
};

/** Cache folder for a media file, keyed by path, size and modification time. */
export function cacheDirFor(ws: Workspace, absFile: string): string {
  const stat = statSync(absFile);
  const key = createHash("sha1").update(`${resolve(absFile)}|${stat.size}|${stat.mtimeMs}`).digest("hex").slice(0, 16);
  return join(ws.cache, key);
}

export function readAnalysis(ws: Workspace, relFile: string): MediaAnalysis {
  const abs = join(ws.root, relFile);
  const empty: MediaAnalysis = { file: relFile, info: null, source: abs, thumb: null, transcript: null, silence: null, status: null };
  if (!existsSync(abs)) return { ...empty, status: { stage: "error", progress: 0, error: "File not found", updatedAt: now() } };
  const dir = cacheDirFor(ws, abs);
  const converted = join(dir, "image.jpg");
  return {
    file: relFile,
    info: readJson<MediaInfo>(join(dir, "info.json")),
    source: existsSync(converted) ? converted : abs,
    thumb: existsSync(join(dir, "thumb.jpg")) ? join(dir, "thumb.jpg") : null,
    transcript: readJson<Transcript>(join(dir, "transcript.json")),
    silence: readJson<SilenceAnalysis>(join(dir, "silence.json")),
    status: readJson<AnalysisStatus>(join(dir, "status.json")),
  };
}

const now = () => new Date().toISOString();
const running = new Map<string, Promise<MediaAnalysis>>();

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probes, thumbnails, detects silences and transcribes a file once. Results are
 * cached, so the Studio and the MCP server can share them and several reels can
 * be cut from one long video without transcribing it again.
 */
export function analyzeMedia(ws: Workspace, relFile: string, onStatus?: (s: AnalysisStatus) => void): Promise<MediaAnalysis> {
  const existing = running.get(relFile);
  if (existing) return existing;
  const job = doAnalyze(ws, relFile, onStatus).finally(() => running.delete(relFile));
  running.set(relFile, job);
  return job;
}

async function doAnalyze(ws: Workspace, relFile: string, onStatus?: (s: AnalysisStatus) => void): Promise<MediaAnalysis> {
  const abs = join(ws.root, relFile);
  if (!existsSync(abs)) throw new Error(`File not found: ${relFile}`);
  const kind = mediaKindOf(abs);
  if (!kind) throw new Error(`Unsupported file type: ${relFile}`);
  const dir = cacheDirFor(ws, abs);
  mkdirSync(dir, { recursive: true });

  const cached = readAnalysis(ws, relFile);
  if (cached.status?.stage === "done") return cached;

  // Another process (Studio vs MCP) may already be analyzing this file.
  const lock = join(dir, "lock");
  const owner = readJson<{ pid: number }>(lock);
  if (owner && owner.pid !== process.pid && pidAlive(owner.pid)) {
    while (existsSync(lock)) {
      await Bun.sleep(1000);
      const s = readAnalysis(ws, relFile).status;
      if (s) onStatus?.(s);
    }
    const after = readAnalysis(ws, relFile);
    if (after.status?.stage === "done") return after;
    throw new Error(after.status?.error ?? "Analysis failed in another process");
  }
  writeJson(lock, { pid: process.pid });

  const setStatus = (stage: AnalysisStage, progress: number, error?: string) => {
    const status: AnalysisStatus = { stage, progress, error, updatedAt: now() };
    writeJson(join(dir, "status.json"), status);
    onStatus?.(status);
  };

  try {
    setStatus("probing", 0.02);
    let source = abs;
    if (kind === "image" && /\.heic$/i.test(abs)) {
      // ffmpeg's HEIC support is patchy; macOS can convert natively.
      const sips = which("sips");
      if (!sips) throw new Error("HEIC photos need macOS (sips). Export them as JPEG instead.");
      source = join(dir, "image.jpg");
      await runOrThrow([sips, "-s", "format", "jpeg", abs, "--out", source]);
    }
    const info = await probe(source, kind);
    writeJson(join(dir, "info.json"), info);

    if (kind !== "audio") {
      const at = kind === "video" ? Math.min(1, info.duration / 2) : 0;
      await runOrThrow([
        ffmpegBin(), "-y", "-v", "error", "-ss", String(at), "-i", source,
        "-frames:v", "1", "-vf", "scale=360:-2", join(dir, "thumb.jpg"),
      ]);
    }

    if (kind === "video" && info.hasAudio) {
      setStatus("audio", 0.05);
      const wav = join(dir, "speech.wav");
      await extractSpeechAudio(abs, wav);

      setStatus("silences", 0.1);
      const silence = await detectSilences(wav, info.duration);
      writeJson(join(dir, "silence.json"), silence);

      setStatus("transcribing", 0.15);
      const settings = readSettings(ws);
      const transcript = await transcribe({
        wav,
        workDir: dir,
        modelPath: join(ws.models, settings.whisperModel),
        language: settings.language,
        onProgress: (f) => setStatus("transcribing", 0.15 + f * 0.84),
      });
      // Keep Whisper's own timing too, so better alignment can be re-applied later.
      writeJson(join(dir, "transcript.raw.json"), transcript);
      const aligned = alignToSpeech(transcript.words, silence.silences, info.duration);
      writeJson(join(dir, "transcript.json"), { ...transcript, words: aligned.words, noise: aligned.unmatched });
      rmSync(wav, { force: true });
    }

    setStatus("done", 1);
    return readAnalysis(ws, relFile);
  } catch (error) {
    setStatus("error", 0, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    rmSync(lock, { force: true });
  }
}


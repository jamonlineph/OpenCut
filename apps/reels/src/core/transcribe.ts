import { existsSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import { ffmpegBin, run, runOrThrow, which } from "./exec";
import type { Interval } from "./intervals";

export type Word = {
  text: string;
  start: number;
  end: number;
  /** um, uh, erm... */
  filler?: boolean;
};

export type Transcript = {
  engine: string;
  model: string;
  language: string;
  words: Word[];
};

// Whisper tends to clean "um" and "uh" out of its transcript, which would make
// them impossible to cut. A prompt written with fillers keeps them in.
const FILLER_PROMPT = "Umm, let me think like, hmm... Okay, here's what I'm, uh, thinking.";

const FILLERS = new Set(["um", "umm", "uhm", "uh", "uhh", "er", "erm", "ah", "ahh", "hmm", "hm", "mm", "mmm", "eh"]);

export function isFiller(text: string): boolean {
  return FILLERS.has(text.toLowerCase().replace(/[^a-z]/g, ""));
}

export function whisperBin(): string | null {
  return which("whisper-cli", "OPENCUT_WHISPER") ?? which("whisper-cpp") ?? null;
}

export async function extractSpeechAudio(input: string, output: string) {
  await runOrThrow([ffmpegBin(), "-y", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output]);
}

type WhisperToken = { text: string; offsets?: { from: number; to: number }; t_dtw?: number };
type WhisperSegment = { offsets: { from: number; to: number }; text: string; tokens?: WhisperToken[] };
type WhisperJson = { result?: { language?: string }; transcription: WhisperSegment[] };

const isSpecial = (text: string) => /^\[_.*\]$/.test(text) || /^<\|.*\|>$/.test(text);

/** Turns whisper.cpp `--output-json-full` into words with times in seconds. */
export function parseWhisperJson(json: WhisperJson): { language: string; words: Word[] } {
  const words: Word[] = [];
  for (const segment of json.transcription ?? []) {
    const tokens = (segment.tokens ?? []).filter((t) => t.text && !isSpecial(t.text.trim()));
    const segFrom = segment.offsets.from / 1000;
    const segTo = segment.offsets.to / 1000;

    if (!tokens.length || tokens.some((t) => !t.offsets)) {
      // No token timing: spread the segment's words over its span by length.
      const parts = segment.text.trim().split(/\s+/).filter(Boolean);
      const total = parts.reduce((n, p) => n + p.length, 0) || 1;
      let t = segFrom;
      for (const part of parts) {
        const d = ((segTo - segFrom) * part.length) / total;
        words.push({ text: part, start: t, end: t + d });
        t += d;
      }
      continue;
    }

    // With DTW (more precise), each token carries the moment it is spoken.
    const useDtw = tokens.every((t) => typeof t.t_dtw === "number" && t.t_dtw >= 0);
    const segmentWords: Word[] = [];
    let current: Word | null = null;
    for (const token of tokens) {
      const from = useDtw ? token.t_dtw! / 100 : token.offsets!.from / 1000;
      const to = token.offsets!.to / 1000;
      const startsWord = token.text.startsWith(" ") || current === null;
      const isPunctuation = /^[\p{P}]+$/u.test(token.text.trim());
      if (startsWord && !(isPunctuation && current)) {
        if (current) segmentWords.push(current);
        current = { text: token.text.trim(), start: from, end: Math.max(to, from) };
      } else if (current) {
        current.text += token.text.trim();
        current.end = Math.max(current.end, to);
      }
    }
    if (current) segmentWords.push(current);
    if (useDtw) {
      // DTW gives starts; a word runs until the next one (pauses are trimmed later).
      segmentWords.forEach((w, i) => {
        const next = segmentWords[i + 1];
        const limit = w.start + Math.min(1.2, Math.max(0.2, w.text.length * 0.09));
        w.end = next && next.start > w.start ? Math.min(next.start, limit) : Math.min(Math.max(w.end, w.start + 0.15), limit, Math.max(segTo, w.start + 0.15));
      });
    }
    words.push(...segmentWords);
  }

  const cleaned = words
    .filter((w) => w.text.length > 0)
    .map((w) => ({ ...w, end: Math.max(w.end, w.start + 0.02) }));
  for (const w of cleaned) if (isFiller(w.text)) w.filler = true;
  return { language: json.result?.language ?? "unknown", words: cleaned };
}

/**
 * Whisper's word times can drift into the pauses around them, which would make
 * silence removal look like it cut real words (and drop them from captions).
 * Uses the detected silences as ground truth:
 * - a word sitting almost entirely in a pause moves to the speech it belongs to
 *   (the next sentence if it's closer to the next word, else the previous one);
 * - word edges hanging into a pause are trimmed back to the speech.
 */
export function alignWordsToSpeech(words: Word[], silences: Interval[]): Word[] {
  const sil = [...silences].sort((a, b) => a.start - b.start);
  const silentPart = (start: number, end: number) =>
    sil.reduce((sum, s) => sum + Math.max(0, Math.min(end, s.end) - Math.max(start, s.start)), 0);
  const out: Word[] = [];
  words.forEach((word, i) => {
    let { start, end } = word;
    const duration = Math.max(0.05, end - start);
    if (silentPart(start, end) > duration * 0.7) {
      const center = (start + end) / 2;
      const pause = sil.find((s) => center >= s.start && center <= s.end) ?? sil.find((s) => s.end > start && s.start < end);
      if (pause) {
        const prev = words[i - 1];
        const next = words[i + 1];
        const gapBefore = prev ? start - prev.end : Infinity;
        const gapAfter = next ? next.start - end : Infinity;
        const length = Math.min(duration, 0.6);
        // Punctuation says which side a word belongs to; fall back to the closer neighbour.
        const endsSentence = /[.?!,;:]$/.test(word.text);
        const startsSentence = !prev || /[.?!]$/.test(prev.text);
        const forward = pause.start <= 0.001 || (startsSentence && !endsSentence) || (!endsSentence && gapBefore > gapAfter);
        if (forward) {
          start = pause.end;
          end = pause.end + length;
        } else {
          end = pause.start;
          start = Math.max(0, pause.start - length);
        }
      }
    }
    for (const s of sil) {
      if (start >= s.start && start < s.end && s.end < end) start = s.end;
      if (end > s.start && end <= s.end && s.start > start) end = s.start;
    }
    const prev = out[out.length - 1];
    if (prev && start < prev.start) start = prev.start + 0.01;
    end = Math.max(end, start + 0.05);
    out.push({ ...word, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 });
  });
  return out;
}

/** whisper.cpp's alignment preset for a model file, for precise (DTW) word timing. */
export function dtwPreset(modelFile: string): string | null {
  const m = modelFile.toLowerCase().match(/ggml-(tiny|base|small|medium|large-v[123](?:-turbo)?)(\.en)?[.-]/);
  return m ? `${m[1]!.replace(/-/g, ".")}${m[2] ?? ""}` : null;
}

export async function transcribe(options: {
  wav: string;
  workDir: string;
  modelPath: string;
  language: string;
  onProgress?: (fraction: number) => void;
}): Promise<Transcript> {
  const bin = whisperBin();
  if (!bin) throw new Error("whisper.cpp not found. Install it with: brew install whisper-cpp");
  if (!existsSync(options.modelPath)) {
    throw new Error(`Whisper model missing at ${options.modelPath}. Run: bun run setup`);
  }
  const outBase = join(options.workDir, "whisper");
  const english = /\.en\.bin$/.test(options.modelPath);
  const args = [
    bin,
    "-m",
    options.modelPath,
    "-f",
    options.wav,
    "-l",
    english ? "en" : options.language || "auto",
    "-t",
    String(Math.max(2, Math.min(8, availableParallelism() - 1))),
    "--prompt",
    FILLER_PROMPT,
    "-ojf",
    "-of",
    outBase,
    "-pp",
  ];
  const onStderr = (chunk: string) => {
    const match = [...chunk.matchAll(/progress\s*=\s*(\d+)%/g)].pop();
    if (match) options.onProgress?.(Number(match[1]) / 100);
  };
  const preset = dtwPreset(options.modelPath.split("/").pop() ?? "");
  const withDtw = preset ? await run([...args, "-dtw", preset], { onStderr }) : null;
  // Older whisper.cpp builds may not support DTW for this model: fall back.
  if (!withDtw || withDtw.code !== 0) await runOrThrow(args, { onStderr });
  const raw = readFileSync(`${outBase}.json`, "utf8");
  rmSync(`${outBase}.json`, { force: true });
  const parsed = parseWhisperJson(JSON.parse(raw) as WhisperJson);
  return {
    engine: "whisper.cpp",
    model: options.modelPath.split("/").pop() ?? "",
    language: parsed.language,
    words: parsed.words,
  };
}

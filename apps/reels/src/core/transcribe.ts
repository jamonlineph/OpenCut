import { existsSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import { ffmpegBin, runOrThrow, which } from "./exec";
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

type WhisperToken = { text: string; offsets?: { from: number; to: number } };
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

    let current: Word | null = null;
    for (const token of tokens) {
      const from = token.offsets!.from / 1000;
      const to = token.offsets!.to / 1000;
      const startsWord = token.text.startsWith(" ") || current === null;
      const isPunctuation = /^[\p{P}]+$/u.test(token.text.trim());
      if (startsWord && !(isPunctuation && current)) {
        if (current) words.push(current);
        current = { text: token.text.trim(), start: from, end: to };
      } else if (current) {
        current.text += token.text.trim();
        current.end = Math.max(current.end, to);
      }
    }
    if (current) words.push(current);
  }

  const cleaned = words
    .filter((w) => w.text.length > 0)
    .map((w) => ({ ...w, end: Math.max(w.end, w.start + 0.02) }));
  for (const w of cleaned) if (isFiller(w.text)) w.filler = true;
  return { language: json.result?.language ?? "unknown", words: cleaned };
}

/**
 * Whisper often stretches a word across the pause that follows it. Where a
 * word edge falls inside a detected silence, pull it back to the speech.
 */
export function snapWordsToSpeech(words: Word[], silences: Interval[]): Word[] {
  return words.map((word) => {
    let { start, end } = word;
    for (const s of silences) {
      if (start >= s.start && start < s.end && s.end < end) start = s.end;
      if (end > s.start && end <= s.end && s.start > start) end = s.start;
    }
    return end - start >= 0.04 ? { ...word, start, end } : word;
  });
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
  await runOrThrow(args, {
    onStderr: (chunk) => {
      const match = [...chunk.matchAll(/progress\s*=\s*(\d+)%/g)].pop();
      if (match) options.onProgress?.(Number(match[1]) / 100);
    },
  });
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

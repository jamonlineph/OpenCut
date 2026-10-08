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
  /** Whisper's timing was off and this placement was inferred from the audio. */
  guessed?: boolean;
};

export type Transcript = {
  engine: string;
  model: string;
  language: string;
  words: Word[];
  /** Stretches of sound no word matched (breaths, clicks, noise). */
  noise?: Interval[];
};

// Whisper tends to clean "um" and "uh" out of its transcript, which would make
// them impossible to cut. A prompt written with fillers keeps them in. It has to
// be in the language spoken: an English prompt nudges Whisper to translate.
const FILLER_PROMPTS: Record<string, string> = {
  en: "Umm, let me think like, hmm... Okay, here's what I'm, uh, thinking.",
  tl: "Ahm, so ayun, parang ganito kasi, uh, okay so here's what I'm thinking.",
  es: "Eh, mmm, bueno... A ver, lo que estoy, eh, pensando es esto.",
  pt: "Ahn, hmm, então... Tipo, o que eu estou, é, pensando é isso.",
  fr: "Euh, hmm, bon... Alors, ce que je, euh, pense c'est ça.",
  de: "Ähm, hmm, also... Was ich, äh, denke, ist Folgendes.",
  id: "Emm, hmm, jadi... Ya, yang aku, eh, pikirin itu gini.",
};
export const fillerPrompt = (language: string) => FILLER_PROMPTS[language] ?? null;

// Sounds only, never real words ("ano", "este", "like" are words too often to cut).
const FILLERS = new Set(["um", "umm", "uhm", "uh", "er", "erm", "ah", "ahm", "eh", "ehm", "emm", "hmm", "hm", "mm", "euh", "ahn"]);
// …except where the sound is a word: Portuguese "um" (one), German "er" (he).
const NOT_FILLERS: Record<string, string[]> = { pt: ["um", "ahn"], de: ["er"], tr: ["eh"] };

export function isFiller(text: string, language = "en"): boolean {
  const plain = text.toLowerCase().normalize("NFD").replace(/[^a-z]/g, ""); // "ähm" → "ahm"
  if (!plain || NOT_FILLERS[language]?.includes(plain)) return false;
  // Also drawn-out versions: "ummm", "uhhh", "ahhh", "hmmm".
  return FILLERS.has(plain) || /^(u+h+m*|u+m{2,}|a+h+m*|e+h+m*|h+m+|m{2,})$/.test(plain);
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
  const language = json.result?.language ?? "unknown";
  for (const w of cleaned) if (isFiller(w.text, language)) w.filler = true;
  return { language, words: cleaned };
}

/** Asks Whisper which language is spoken (one quick pass over the first 30 seconds). */
async function detectLanguage(bin: string, model: string, wav: string, threads: string): Promise<string | null> {
  const result = await run([bin, "-m", model, "-f", wav, "-l", "auto", "-dl", "-t", threads]).catch(() => null);
  return parseDetectedLanguage(`${result?.stderr ?? ""}\n${result?.stdout ?? ""}`);
}

/** Reads "auto-detected language: tl (p = 0.71)" from whisper.cpp's log. */
export function parseDetectedLanguage(log: string): string | null {
  return log.match(/auto-detected language:\s*([a-z]{2,3})\b/i)?.[1]?.toLowerCase() ?? null;
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
  const threads = String(Math.max(2, Math.min(8, availableParallelism() - 1)));
  let language = english ? "en" : options.language || "auto";
  // Find out what is spoken first, so the filler prompt can match it.
  if (language === "auto") language = (await detectLanguage(bin, options.modelPath, options.wav, threads)) ?? "auto";
  const prompt = fillerPrompt(language) ?? (language === "auto" ? fillerPrompt("en") : null);
  const args = [
    bin,
    "-m",
    options.modelPath,
    "-f",
    options.wav,
    "-l",
    language,
    "-t",
    threads,
    ...(prompt ? ["--prompt", prompt] : []),
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

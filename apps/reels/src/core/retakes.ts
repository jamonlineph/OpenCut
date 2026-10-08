import type { TimedWord } from "./timeline";

// Finds false starts and repeated takes in a talking-head transcript, so the
// earlier, abandoned attempt can be cut and the last take kept:
//
//   "So today I wa-  So today I want to show you…"   → cut the first attempt
//   "This is the best tool. This is the best tool for editing."  → cut the first
//   "Here's the thing… sorry, let me start again. Here's the thing:" → cut both

type Sentence = { words: TimedWord[]; norm: string[] };

const RESTART = /\b(sorry|again|start over|let me (re)?start|one more time|wait|hold on|scratch that|ulit|teka|ay mali)\b/i;

const norm = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}']/gu, "");

function sentences(words: TimedWord[]): Sentence[] {
  const out: Sentence[] = [];
  let current: TimedWord[] = [];
  const flush = () => {
    if (current.length) out.push({ words: current, norm: current.filter((w) => !w.filler).map((w) => norm(w.text)).filter(Boolean) });
    current = [];
  };
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (prev && (prev.asset !== w.asset || w.start - prev.end > 0.7)) flush();
    current.push(w);
    if (/[.?!]$|[-–—]$/.test(w.text)) flush();
  });
  flush();
  return out;
}

function commonPrefix(a: string[], b: string[]) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function similarity(a: string[], b: string[]) {
  const sa = new Set(a);
  const sb = new Set(b);
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / Math.max(sa.size, sb.size, 1);
}

/** True when `later` looks like a new attempt at what `earlier` was saying. */
function isRetakeOf(earlier: Sentence, later: Sentence): boolean {
  const a = earlier.norm;
  const b = later.norm;
  if (a.length < 2 || b.length < 2) return false;
  const prefix = commonPrefix(a, b);
  const last = earlier.words[earlier.words.length - 1]!.text;
  const finished = /[.?!]$/.test(last) && !/[-–—]$/.test(last);
  // A cut-off attempt: it stops right after (or soon after) the words the retake repeats.
  if (prefix >= 2 && (prefix === a.length || (!finished && (prefix >= 3 || a.length - prefix <= 2)))) return true;
  // A whole sentence said twice. Parallel sentences ("I want to show you X. I want to
  // show you Y.") share a start but differ after it, so require near-identical wording.
  return a.length >= 4 && Math.abs(a.length - b.length) <= Math.max(3, a.length * 0.3) && similarity(a, b) >= 0.8;
}

type Spoken = { id: number; norm: string };

/** "so the first thing, so the first thing is…" inside one sentence: the words before the restart. */
function restartsWithin(words: TimedWord[]): [number, number][] {
  const seq: Spoken[] = words.filter((w) => !w.filler).map((w) => ({ id: w.id, norm: norm(w.text) })).filter((w) => w.norm);
  const cuts: [number, number][] = [];
  for (let i = 0; i < seq.length; i++) {
    for (let gap = 2; gap <= 10 && i + gap < seq.length; gap++) {
      let m = 0;
      while (m < gap && i + gap + m < seq.length && seq[i + m]!.norm === seq[i + gap + m]!.norm) m++;
      // Restart right away ("so the first thing so the first thing"), or after one or
      // two words of hesitation ("I think, no wait, I think").
      if ((m === gap && m >= 2) || (m >= 3 && gap - m <= 2)) {
        cuts.push([seq[i]!.id, seq[i + gap - 1]!.id]);
        i += gap - 1;
        break;
      }
    }
  }
  return cuts;
}

/** Word-id ranges to cut, given the words currently in the reel in play order. */
export function findRetakes(words: TimedWord[]): [number, number][] {
  const list = sentences(words);
  const cuts: [number, number][] = [];
  const ids = (s: Sentence): [number, number] => [s.words[0]!.id, s.words[s.words.length - 1]!.id];
  const dropped = new Set<number>();
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i]!;
    const b = list[i + 1]!;
    if (b.words[0]!.outStart - a.words[a.words.length - 1]!.outEnd > 20) continue;
    if (isRetakeOf(a, b)) {
      cuts.push(ids(a));
      dropped.add(i);
      continue;
    }
    // "…sorry, let me start again." between two attempts.
    const c = list[i + 2];
    if (c && b.norm.length <= 6 && RESTART.test(b.words.map((w) => w.text).join(" ")) && commonPrefix(a.norm, c.norm) >= 2) {
      cuts.push(ids(a), ids(b));
      dropped.add(i).add(i + 1);
      i++;
    }
  }
  list.forEach((s, i) => {
    if (!dropped.has(i)) cuts.push(...restartsWithin(s.words));
  });
  return cuts.sort((x, y) => x[0] - y[0]);
}

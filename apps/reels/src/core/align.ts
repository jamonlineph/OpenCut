import type { Interval } from "./intervals";
import type { Word } from "./transcribe";

// Whisper's word times drift, sometimes by a second, and fillers are the worst:
// "um" can be stamped on top of the word before it while its real audio sits in
// a pause of its own. Silence detection measures the audio directly, so it is the
// ground truth for *where* speech is. This matches the word sequence to the
// detected stretches of speech, in order, then times each word inside its stretch.

/** Stretches of audio between detected silences. */
export function speechRegions(silences: Interval[], duration: number): Interval[] {
  const sorted = [...silences].sort((a, b) => a.start - b.start);
  const regions: Interval[] = [];
  let t = 0;
  for (const s of sorted) {
    if (s.start - t > 0.04) regions.push({ start: t, end: s.start });
    t = Math.max(t, s.end);
  }
  if (duration - t > 0.04) regions.push({ start: t, end: duration });
  return regions;
}

const gap = (w: Word, r: Interval) => Math.max(0, r.start - w.end, w.start - r.end);

/** How unlikely a word is to belong to a region: free if it overlaps, otherwise distance plus a jump. */
const cost = (w: Word, r: Interval) => {
  const d = gap(w, r);
  return d > 0 ? d + 1 : 0;
};

/** Cost of a stretch of sound that no word was matched to (speech is rarely wordless). */
const emptyCost = (r: Interval) => 0.5 + Math.min(1, r.end - r.start);

/**
 * Assigns every word to a speech region, in order, minimising how far words must
 * move plus a penalty for each region left without words (dynamic programming).
 */
function assign(words: Word[], regions: Interval[]): number[] {
  const n = words.length;
  const m = regions.length;
  const pre = [0];
  for (const r of regions) pre.push(pre[pre.length - 1]! + emptyCost(r));
  const emptyRange = (from: number, to: number) => pre[to]! - pre[from]!; // regions from..to-1 unused

  const back = new Int32Array(n * m);
  let prev = new Float64Array(m);
  for (let j = 0; j < m; j++) prev[j] = cost(words[0]!, regions[j]!) + emptyRange(0, j) * 0.5; // leading noise is cheaper
  for (let i = 1; i < n; i++) {
    const cur = new Float64Array(m);
    let bestK = -1;
    let best = Infinity; // min over k < j of prev[k] - pre[k + 1]
    for (let j = 0; j < m; j++) {
      // Stay in the same region as the previous word…
      let value = prev[j]!;
      let from = j;
      // …or move on from an earlier region, leaving the ones in between empty.
      if (bestK >= 0 && best + pre[j]! < value) {
        value = best + pre[j]!;
        from = bestK;
      }
      cur[j] = value + cost(words[i]!, regions[j]!);
      back[i * m + j] = from;
      if (prev[j]! - pre[j + 1]! < best) {
        best = prev[j]! - pre[j + 1]!;
        bestK = j;
      }
    }
    prev = cur;
  }
  let end = 0;
  let total = Infinity;
  for (let j = 0; j < m; j++) {
    const value = prev[j]! + emptyRange(j + 1, m) * 0.5; // trailing noise is cheaper too
    if (value < total) {
      total = value;
      end = j;
    }
  }
  const out = new Array<number>(n);
  out[n - 1] = end;
  for (let i = n - 1; i > 0; i--) out[i - 1] = back[i * m + out[i]!]!;
  return out;
}

/**
 * Re-times words so each sits inside the speech it belongs to. Returns the new
 * words plus the speech regions no word was matched to (breaths, clicks, noise).
 */
export function alignToSpeech(words: Word[], silences: Interval[], duration: number): { words: Word[]; unmatched: Interval[] } {
  const regions = speechRegions(silences, duration);
  if (!words.length || !regions.length || words.length * regions.length > 40_000_000) {
    return { words, unmatched: [] };
  }
  const region = assign(words, regions);

  // An unmatched stretch next to a filler is almost always that filler, mis-timed
  // by Whisper onto a neighbouring word: give it its own stretch back.
  const members = () => {
    const map = new Map<number, number[]>();
    region.forEach((r, i) => map.set(r, [...(map.get(r) ?? []), i]));
    return map;
  };
  let byRegion = members();
  for (let j = 0; j < regions.length; j++) {
    if (byRegion.has(j) || regions[j]!.end - regions[j]!.start > 1.2) continue;
    const before = [...byRegion.keys()].filter((k) => k < j).sort((a, b) => b - a)[0];
    const after = [...byRegion.keys()].filter((k) => k > j).sort((a, b) => a - b)[0];
    const lastBefore = before !== undefined ? byRegion.get(before)!.at(-1) : undefined;
    const firstAfter = after !== undefined ? byRegion.get(after)![0] : undefined;
    if (lastBefore !== undefined && words[lastBefore]!.filler && byRegion.get(before!)!.length > 1) region[lastBefore] = j;
    else if (firstAfter !== undefined && words[firstAfter]!.filler && byRegion.get(after!)!.length > 1) region[firstAfter] = j;
    else continue;
    byRegion = members();
  }

  const out = words.map((w) => ({ ...w }));
  for (const [j, ids] of byRegion) {
    const r = regions[j]!;
    const list = ids.map((i) => out[i]!);
    const plausible =
      list.every((w) => w.start >= r.start - 0.1 && w.end <= r.end + 0.1) &&
      list.every((w, k) => k === 0 || w.start >= list[k - 1]!.start);
    if (plausible) {
      // Whisper's own timing fits: keep it, just clamped to the speech.
      for (const w of list) {
        w.start = Math.max(r.start, Math.min(w.start, r.end - 0.03));
        w.end = Math.min(r.end, Math.max(w.end, w.start + 0.03));
      }
      continue;
    }
    // Otherwise spread the words over the stretch by length (≈ how long they take to say).
    const weights = list.map((w) => Math.max(2, w.text.replace(/[^\p{L}\p{N}]/gu, "").length) + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = r.start;
    list.forEach((w, k) => {
      const d = ((r.end - r.start) * weights[k]!) / total;
      w.start = t;
      w.end = t + d;
      t += d;
    });
  }
  for (const w of out) {
    w.start = Math.round(w.start * 1000) / 1000;
    w.end = Math.round(w.end * 1000) / 1000;
  }
  const unmatched = regions.filter((_, j) => !byRegion.has(j));
  return { words: out, unmatched };
}

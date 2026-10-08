import type { Interval } from "./intervals";
import type { Word } from "./transcribe";

// Whisper's word times drift, sometimes by a second. Typical mistakes on real
// footage: the word before a pause gets its end stretched over the pause, "um" is
// stamped on top of a neighbouring word while its audio sits in a gap of its own,
// and a few words after a pause slide into the stretch of sound before it.
// Silence detection measures the audio directly, so it is the ground truth for
// *where* speech is. This matches the word sequence to the detected stretches of
// speech, in order, then times each word inside its stretch.

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

const WINDOW = 6; // seconds Whisper can plausibly be off by
const TOLERANCE = 0.1; // speech onsets are soft, so starting just before a stretch is fine
const OUTSIDE = 1; // flat cost for moving a word out of the stretch Whisper put it in
const FREE_PACE = 1.15; // a phrase can be this much faster than the speaker's average for free…
const OVERFILL = 8; // …beyond that, packing words into a stretch gets expensive
const UNDERFILL = 0.5;
const FLOATING_SHARED = 3; // a filler Whisper put inside a pause is almost always a stretch of its own
const RUN_ON = 0.4; // a sentence end usually comes with a pause, so a stretch running past one is a little suspect

/** Rough length of a word in speech, in letters plus a beat. */
const units = (w: Word) => w.text.replace(/[^\p{L}\p{N}]/gu, "").length + 1;

/**
 * How unlikely a word is to belong to a region. Whisper's start times are the
 * reliable part: ends are often stretched across the pause that follows.
 */
const cost = (w: Word, r: Interval) => {
  const d = Math.max(0, r.start - w.start, w.start - r.end) - TOLERANCE;
  return d > 0 ? d + OUTSIDE : 0;
};

/** Cost of a stretch of sound that no word was matched to (speech is rarely wordless). */
const emptyCost = (r: Interval) => 0.5 + Math.min(1, r.end - r.start);

/**
 * Assigns every word to a speech region, in order, minimising how far words move,
 * how implausibly fast any stretch would have to be spoken, and how many stretches
 * are left without words. Dynamic programming over runs of words per region,
 * restricted to words within a few seconds of each region.
 */
function assign(words: Word[], regions: Interval[]): number[] {
  const n = words.length;
  const m = regions.length;
  const pre = [0];
  for (const w of words) pre.push(pre[pre.length - 1]! + units(w));

  // Whisper often stamps "um" in the middle of a pause or on top of a neighbouring
  // word, and sometimes puts the next words on the um's own burst of sound. Such a
  // "floating" filler says nothing about where it is, so it moves for free, but it
  // shouldn't share a stretch with words (people pause around "um").
  const overlap = (a: Word, b: Interval) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const floating = words.map((w, i) => {
    if (!w.filler) return false;
    const length = Math.max(w.end - w.start, 0.05);
    const inSpeech = regions.reduce((sum, r) => sum + overlap(w, r), 0);
    const onWords = Math.max(...[words[i - 1], words[i + 1]].map((o) => (o && !o.filler ? overlap(w, o) : 0)));
    return inSpeech <= 0.25 * length || onWords >= 0.5 * length;
  });
  const preFloating = [0];
  const preFiller = [0];
  words.forEach((w, i) => {
    preFloating.push(preFloating[i]! + (floating[i] ? 1 : 0));
    preFiller.push(preFiller[i]! + (w.filler ? 1 : 0));
  });
  const preEnds = [0];
  words.forEach((w, i) => preEnds.push(preEnds[i]! + (/[.!?]["')\]]*$/.test(w.text) ? 1 : 0)));
  const runOn = (a: number, b: number) => RUN_ON * (preEnds[b - 1]! - preEnds[a]!); // sentence ends before the run's last word
  const sharing = (a: number, b: number) => {
    const f = preFloating[b]! - preFloating[a]!;
    return f && b - a > preFiller[b]! - preFiller[a]! ? f * FLOATING_SHARED : 0;
  };

  // Speaker's pace from the stretches that have a word starting in them.
  let spoken = 0;
  let k = 0;
  for (const r of regions) {
    while (k < n && words[k]!.start < r.start - TOLERANCE) k++;
    if (k < n && words[k]!.start < r.end) spoken += r.end - r.start;
  }
  const pace = pre[n]! / Math.max(spoken, 0.5);
  const paceCost = (u: number, r: Interval) => {
    const ratio = u / pace / (r.end - r.start + 0.05);
    if (ratio > FREE_PACE) return OVERFILL * Math.log(ratio / FREE_PACE);
    if (ratio < 0.5) return UNDERFILL * Math.log(0.5 / ratio);
    return 0;
  };

  // Row j holds b = number of words placed in regions 0..j. Words starting well
  // before region j+1 must be placed by then (lo); words starting well after
  // region j can't be (hi).
  const starts: number[] = [];
  for (const w of words) starts.push(Math.max(w.start, starts.at(-1) ?? -Infinity));
  const countBefore = (t: number) => {
    let a = 0;
    let b = n;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (starts[mid]! < t) a = mid + 1;
      else b = mid;
    }
    return a;
  };
  const lo: number[] = [];
  const hi: number[] = [];
  for (let j = 0; j < m; j++) {
    const h = j === m - 1 ? n : countBefore(regions[j]!.end + WINDOW);
    const l = j === m - 1 ? n : countBefore(regions[j + 1]!.start - WINDOW);
    hi.push(Math.max(h, hi[j - 1] ?? 0));
    lo.push(Math.min(Math.max(l, lo[j - 1] ?? 0), hi[j]!));
  }

  const rows: Float64Array[] = [];
  const back: Int32Array[] = [];
  const at = (j: number, b: number) => (j < 0 ? (b === 0 ? 0 : Infinity) : b < lo[j]! || b > hi[j]! ? Infinity : rows[j]![b - lo[j]!]!);
  for (let j = 0; j < m; j++) {
    const r = regions[j]!;
    const row = new Float64Array(hi[j]! - lo[j]! + 1).fill(Infinity);
    const from = new Int32Array(row.length);
    const prevLo = j === 0 ? 0 : lo[j - 1]!;
    const prevHi = j === 0 ? 0 : hi[j - 1]!;
    for (let b = lo[j]!; b <= hi[j]!; b++) {
      // Region j left empty (leading and trailing noise is cheaper)…
      let best = at(j - 1, b) + emptyCost(r) * (b === 0 || b === n ? 0.5 : 1);
      let bestA = b;
      // …or holding words a..b-1.
      let moved = 0;
      for (let a = b - 1; a >= prevLo; a--) {
        if (!floating[a]) moved += cost(words[a]!, r);
        if (moved >= best) break;
        if (a > prevHi) continue;
        const value = at(j - 1, a) + moved + paceCost(pre[b]! - pre[a]!, r) + sharing(a, b) + runOn(a, b);
        if (value < best) {
          best = value;
          bestA = a;
        }
      }
      row[b - lo[j]!] = best;
      from[b - lo[j]!] = bestA;
    }
    rows.push(row);
    back.push(from);
  }

  const out = new Array<number>(n);
  let b = n;
  for (let j = m - 1; j >= 0; j--) {
    const a = back[j]![b - lo[j]!]!;
    for (let i = a; i < b; i++) out[i] = j;
    b = a;
  }
  return out;
}

/**
 * Re-times words so each sits inside the speech it belongs to. Returns the new
 * words plus the speech regions no word was matched to (breaths, clicks, noise).
 */
export function alignToSpeech(words: Word[], silences: Interval[], duration: number): { words: Word[]; unmatched: Interval[] } {
  const regions = speechRegions(silences, duration);
  if (!words.length || !regions.length) return { words, unmatched: [] };
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
      list.every((w) => w.start >= r.start - 0.15 && w.start < r.end - 0.03) &&
      list.every((w, k) => k === 0 || w.start >= list[k - 1]!.start);
    if (plausible) {
      // Whisper's own timing fits: keep it, clamped to the speech. Speech inside a
      // stretch is continuous, so the first word starts and the last ends with it.
      list.forEach((w, k) => {
        w.start = k === 0 ? r.start : Math.max(r.start, w.start);
        w.end = k === list.length - 1 ? r.end : Math.min(r.end, Math.max(w.end, w.start + 0.03));
      });
      continue;
    }
    // Otherwise spread the words over the stretch by length (≈ how long they take to say).
    const weights = list.map(units);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = r.start;
    list.forEach((w, k) => {
      const d = ((r.end - r.start) * weights[k]!) / total;
      w.start = t;
      w.end = t + d;
      t += d;
    });
  }
  out.forEach((w, i) => {
    w.start = Math.round(w.start * 1000) / 1000;
    w.end = Math.round(w.end * 1000) / 1000;
    // Nowhere near where Whisper heard it: the placement is an inference.
    const raw = words[i]!;
    if (Math.max(w.start - raw.end, raw.start - w.end) > 0.2) w.guessed = true;
  });
  const unmatched = regions.filter((_, j) => !byRegion.has(j));
  return { words: out, unmatched };
}

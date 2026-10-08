export type Interval = { start: number; end: number };

/** Removes every `cut` interval from `range`, returning what is left in order. */
export function subtract(range: Interval, cuts: Interval[]): Interval[] {
  let pieces: Interval[] = [range];
  for (const cut of [...cuts].sort((a, b) => a.start - b.start)) {
    if (cut.end <= cut.start) continue;
    const next: Interval[] = [];
    for (const piece of pieces) {
      if (cut.end <= piece.start || cut.start >= piece.end) {
        next.push(piece);
        continue;
      }
      if (cut.start > piece.start) next.push({ start: piece.start, end: cut.start });
      if (cut.end < piece.end) next.push({ start: cut.end, end: piece.end });
    }
    pieces = next;
  }
  return pieces;
}

/** Sorts and merges overlapping or touching intervals. */
export function union(intervals: Interval[], joinGap = 0): Interval[] {
  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end + joinGap) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;

import type { Project } from "./schema";
import { keptWords, placeClips, type EditContext, type PWord } from "./timeline";

const fmt = (t: number) => `${t.toFixed(1)}s`;

/**
 * A compact, token-cheap transcript for agents. One line per phrase:
 *
 *   #12-#25 [3.4s-7.9s] Today I want to ~~um~~ show you (pause 1.2s) three things.
 *
 * Words already cut from the reel are wrapped in ~~strikes~~.
 */
export function formatTranscript(
  project: Project,
  ctx: EditContext,
  options: { fromWord?: number; limit?: number; detail?: "phrases" | "words" } = {},
): string {
  const kept = new Set(keptWords(ctx, placeClips(project)).map((w) => w.id));
  const from = options.fromWord ?? 0;
  const limit = options.limit ?? 600;
  const slice = ctx.words.slice(from, from + limit);
  if (!ctx.words.length) return "No speech found in this project's videos.";

  const lines: string[] = [];
  const assetName = (id: string) => project.assets.find((a) => a.id === id)?.name ?? id;

  if (options.detail === "words") {
    let asset = "";
    for (const w of slice) {
      if (w.asset !== asset) lines.push(`== ${w.asset} (${assetName(w.asset)}) ==`), (asset = w.asset);
      lines.push(`#${w.id} ${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.text}${w.filler ? " (filler)" : ""}${kept.has(w.id) ? "" : " (cut)"}`);
    }
  } else {
    let phrase: PWord[] = [];
    let asset = "";
    const flush = () => {
      if (!phrase.length) return;
      const first = phrase[0]!;
      const last = phrase[phrase.length - 1]!;
      const parts: string[] = [];
      phrase.forEach((w, i) => {
        const prev = phrase[i - 1];
        if (prev && w.start - prev.end >= 0.6) parts.push(`(pause ${(w.start - prev.end).toFixed(1)}s)`);
        parts.push(kept.has(w.id) ? w.text : `~~${w.text}~~`);
      });
      lines.push(`#${first.id}-#${last.id} [${fmt(first.start)}-${fmt(last.end)}] ${parts.join(" ")}`);
      phrase = [];
    };
    for (const w of slice) {
      if (w.asset !== asset) {
        flush();
        lines.push(`== ${w.asset} (${assetName(w.asset)}) ==`);
        asset = w.asset;
      }
      const prev = phrase[phrase.length - 1];
      if (prev && (w.start - prev.end > 1.5 || phrase.length >= 24)) flush();
      phrase.push(w);
      if (/[.?!]$/.test(w.text) && phrase.length >= 4) flush();
    }
    flush();
  }

  const end = from + slice.length;
  if (end < ctx.words.length) lines.push(`… ${ctx.words.length - end} more words. Call again with fromWord=${end}.`);
  return lines.join("\n");
}

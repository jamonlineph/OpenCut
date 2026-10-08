import type { Captions, Project, TextItem } from "../schema";
import { keptWords, resolveTime, type EditContext, type PlacedClip, type TimedWord } from "../timeline";

// Captions and titles are built once as backend-neutral events, then drawn
// either by libass (ASS subtitles) or by the built-in image renderer.

export type TextStyle = {
  font: string;
  /** Pixel sizes are authored for a 1920px-tall canvas and scaled to the real one. */
  size: number;
  weight: number;
  color: string;
  highlight: string;
  outlineColor: string;
  /** 0 = opaque, 255 = invisible (ASS convention). */
  outlineAlpha: number;
  /** 1 = outlined text, 3 = text on a box. */
  borderStyle: 1 | 3;
  outline: number;
  shadow: number;
  uppercase: boolean;
};

export type Placement = { alignment: 2 | 5 | 8; marginV: number };

export type CaptionEvent = {
  layer: number;
  start: number;
  end: number;
  style: TextStyle;
  placement: Placement;
  parts: { text: string; highlight: boolean }[];
  /** Scale-in animation at the start (libass only). */
  pop: boolean;
  fade: boolean;
};

export const CAPTION_STYLES: Record<Captions["style"], TextStyle> = {
  // Big, punchy, all caps, yellow active word. The classic reels look.
  bold: { font: "Arial Black", size: 84, weight: 900, color: "#FFFFFF", highlight: "#FFE600", outlineColor: "#000000", outlineAlpha: 0, borderStyle: 1, outline: 7, shadow: 2, uppercase: true },
  // White text on a soft dark box, green active word.
  clean: { font: "Helvetica Neue", size: 66, weight: 700, color: "#FFFFFF", highlight: "#5CFF8A", outlineColor: "#000000", outlineAlpha: 0x60, borderStyle: 3, outline: 14, shadow: 0, uppercase: false },
  // Understated subtitles.
  minimal: { font: "Helvetica Neue", size: 60, weight: 700, color: "#FFFFFF", highlight: "#FFFFFF", outlineColor: "#000000", outlineAlpha: 0x40, borderStyle: 1, outline: 3, shadow: 2, uppercase: false },
};

export const TEXT_STYLES: Record<TextItem["style"], TextStyle> = {
  hook: { font: "Arial Black", size: 70, weight: 900, color: "#FFFFFF", highlight: "#FFFFFF", outlineColor: "#000000", outlineAlpha: 0x20, borderStyle: 3, outline: 22, shadow: 0, uppercase: false },
  label: { font: "Helvetica Neue", size: 54, weight: 600, color: "#FFFFFF", highlight: "#FFFFFF", outlineColor: "#000000", outlineAlpha: 0x50, borderStyle: 3, outline: 14, shadow: 0, uppercase: false },
};

const CAPTION_PLACEMENT: Record<Captions["position"], Placement> = {
  lower: { alignment: 2, marginV: 520 },
  middle: { alignment: 5, marginV: 0 },
  upper: { alignment: 8, marginV: 420 },
};

const TEXT_PLACEMENT: Record<TextItem["position"], Placement> = {
  top: { alignment: 8, marginV: 300 },
  center: { alignment: 5, marginV: 0 },
  bottom: { alignment: 2, marginV: 820 },
};

/** Horizontal margin on each side, in 1920-tall canvas pixels. */
export const SIDE_MARGIN = 80;

type Chunk = { words: TimedWord[]; start: number; end: number };

export function captionChunks(words: TimedWord[], maxWords: number): Chunk[] {
  const spoken = words.filter((w) => !w.filler);
  const chunks: Chunk[] = [];
  let current: TimedWord[] = [];
  const flush = () => {
    if (current.length) chunks.push({ words: current, start: current[0]!.outStart, end: current[current.length - 1]!.outEnd });
    current = [];
  };
  for (const w of spoken) {
    const prev = current[current.length - 1];
    if (prev && (current.length >= maxWords || w.outStart - prev.outEnd > 0.5)) flush();
    current.push(w);
    if (/[.?!,;:]$/.test(w.text)) flush();
  }
  flush();
  // Hold each caption until the next one if the gap is short, so text doesn't flicker.
  chunks.forEach((c, i) => {
    const next = chunks[i + 1];
    c.end = next && next.start - c.end < 0.35 ? next.start : c.end + 0.15;
    if (next) c.end = Math.min(c.end, next.start);
  });
  return chunks;
}

export function captionStyle(cap: Captions): TextStyle {
  const def = CAPTION_STYLES[cap.style];
  return {
    ...def,
    font: cap.font ?? def.font,
    size: cap.fontSize ?? def.size,
    color: cap.color ?? def.color,
    highlight: cap.highlightColor ?? def.highlight,
    uppercase: cap.uppercase ?? def.uppercase,
  };
}

export function buildCaptionEvents(project: Project, ctx: EditContext, placed: PlacedClip[], total: number): CaptionEvent[] {
  const events: CaptionEvent[] = [];
  const add = (e: CaptionEvent) => {
    const end = Math.min(e.end, total);
    if (end - e.start >= 0.04 && e.start < total) events.push({ ...e, end });
  };

  const cap = project.captions;
  if (cap.enabled) {
    const style = captionStyle(cap);
    const placement = CAPTION_PLACEMENT[cap.position];
    const word = (w: TimedWord) => (style.uppercase ? w.text.toUpperCase() : w.text);
    const highlight = cap.highlight && style.highlight.toUpperCase() !== style.color.toUpperCase();
    for (const chunk of captionChunks(keptWords(ctx, placed), cap.maxWords)) {
      if (!highlight) {
        add({ layer: 1, start: chunk.start, end: chunk.end, style, placement, parts: chunk.words.map((w) => ({ text: word(w), highlight: false })), pop: true, fade: false });
        continue;
      }
      chunk.words.forEach((active, i) => {
        add({
          layer: 1,
          start: i === 0 ? chunk.start : active.outStart,
          end: i === chunk.words.length - 1 ? chunk.end : chunk.words[i + 1]!.outStart,
          style,
          placement,
          parts: chunk.words.map((w) => ({ text: word(w), highlight: w === active })),
          pop: i === 0,
          fade: false,
        });
      });
    }
  }

  for (const t of project.texts) {
    const start = resolveTime(t.start, "start", ctx, placed);
    const end = resolveTime(t.end, "end", ctx, placed);
    if (start === null || end === null || end <= start) continue;
    add({ layer: 2, start, end, style: TEXT_STYLES[t.style], placement: TEXT_PLACEMENT[t.position], parts: [{ text: t.text, highlight: false }], pop: true, fade: true });
  }
  return events;
}

// ───────────────────────── ASS (libass) backend

/** "#RRGGBB" → ASS "&HAABBGGRR". */
export function assColor(hex: string, alpha = 0): string {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return "&H00FFFFFF";
  const a = alpha.toString(16).padStart(2, "0");
  return `&H${a}${m[3]}${m[2]}${m[1]}`.toUpperCase();
}

export function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** ASS has no escape for braces or backslashes, so swap them for safe lookalikes. */
const clean = (text: string) => text.replace(/\\/g, "/").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\r?\n/g, "\\N");

export function toAss(canvas: { width: number; height: number }, events: CaptionEvent[]): string {
  const k = canvas.height / 1920;
  const px = (n: number) => Math.round(n * k);
  const styles = new Map<TextStyle, string>();
  const styleName = (s: TextStyle) => {
    if (!styles.has(s)) styles.set(s, `S${styles.size}`);
    return styles.get(s)!;
  };
  const body = events.map((e) => {
    const s = e.style;
    const anim = [
      `\\an${e.placement.alignment}`,
      e.fade ? "\\fad(120,120)" : "",
      e.pop ? "\\fscx85\\fscy85\\t(0,110,\\fscx100\\fscy100)" : "",
    ].join("");
    const text = e.parts
      .map((p) => (p.highlight ? `{\\1c${assColor(s.highlight)}}${clean(p.text)}{\\1c${assColor(s.color)}}` : clean(p.text)))
      .join(" ");
    return `Dialogue: ${e.layer},${assTime(e.start)},${assTime(e.end)},${styleName(s)},,0,0,${px(e.placement.marginV)},,{${anim}}${text}`;
  });
  const styleLines = [...styles].map(
    ([s, name]) =>
      `Style: ${name},${s.font},${px(s.size)},${assColor(s.color)},${assColor(s.color)},${assColor(s.outlineColor, s.outlineAlpha)},${assColor("#000000", 0x80)},` +
      `${s.weight >= 600 ? -1 : 0},0,0,0,100,100,0,0,${s.borderStyle},${px(s.outline)},${px(s.shadow)},2,${px(SIDE_MARGIN)},${px(SIDE_MARGIN)},0,1`,
  );
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styleLines,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...body,
    "",
  ].join("\n");
}

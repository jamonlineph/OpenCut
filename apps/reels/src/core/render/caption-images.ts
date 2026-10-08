import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";

import { SIDE_MARGIN, type CaptionEvent } from "./captions";

// Draws captions and titles as transparent PNGs, one per change on screen, and
// lists them in an ffconcat file that plays them back in time. This needs no
// libass, so it works with Homebrew's stock FFmpeg.

const loadedFontDirs = new Set<string>();

function rgba(hex: string, assAlpha = 0) {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  const [r, g, b] = m ? [m[1], m[2], m[3]].map((h) => parseInt(h!, 16)) : [255, 255, 255];
  return `rgba(${r},${g},${b},${((255 - assAlpha) / 255).toFixed(3)})`;
}

function drawEvent(g: SKRSContext2D, e: CaptionEvent, W: number, H: number) {
  const k = H / 1920;
  const s = e.style;
  const maxWidth = W - 2 * SIDE_MARGIN * k;
  let size = s.size * k;
  const setFont = () => (g.font = `${s.weight} ${size}px "${s.font}", "Helvetica Neue", "Arial Black", Arial, sans-serif`);
  setFont();

  // Shrink a word that can't fit on a line by itself.
  const widest = Math.max(...e.parts.map((p) => g.measureText(p.text).width));
  if (widest > maxWidth) {
    size *= maxWidth / widest;
    setFont();
  }
  const space = g.measureText(" ").width;

  // Greedy word wrap, like libass's smart wrapping.
  type Word = { text: string; highlight: boolean; width: number };
  const lines: { words: Word[]; width: number }[] = [];
  for (const part of e.parts) {
    const words = part.text.split(/\s+/).filter(Boolean).map((text) => ({ text, highlight: part.highlight, width: g.measureText(text).width }));
    for (const word of words) {
      const line = lines[lines.length - 1];
      if (line && line.width + space + word.width <= maxWidth) {
        line.words.push(word);
        line.width += space + word.width;
      } else lines.push({ words: [word], width: word.width });
    }
  }

  const lineHeight = size * 1.18;
  const blockHeight = lines.length * lineHeight;
  const marginV = e.placement.marginV * k;
  const top =
    e.placement.alignment === 2 ? H - marginV - blockHeight : e.placement.alignment === 8 ? marginV : (H - blockHeight) / 2;

  g.textBaseline = "middle";
  g.textAlign = "left";
  g.lineJoin = "round";
  lines.forEach((line, i) => {
    const x0 = (W - line.width) / 2;
    const y = top + i * lineHeight + lineHeight / 2;
    if (s.borderStyle === 3) {
      const pad = s.outline * k;
      g.fillStyle = rgba(s.outlineColor, s.outlineAlpha);
      g.beginPath();
      g.roundRect(x0 - pad, y - lineHeight / 2 - pad * 0.35, line.width + pad * 2, lineHeight + pad * 0.7, 10 * k);
      g.fill();
    }
    const eachWord = (draw: (w: Word, x: number) => void) => {
      let x = x0;
      for (const w of line.words) {
        draw(w, x);
        x += w.width + space;
      }
    };
    if (s.borderStyle === 1) {
      if (s.shadow > 0) {
        g.fillStyle = "rgba(0,0,0,0.5)";
        g.strokeStyle = "rgba(0,0,0,0.5)";
        g.lineWidth = s.outline * 2 * k;
        eachWord((w, x) => {
          g.strokeText(w.text, x + s.shadow * k, y + s.shadow * k);
          g.fillText(w.text, x + s.shadow * k, y + s.shadow * k);
        });
      }
      if (s.outline > 0) {
        g.strokeStyle = rgba(s.outlineColor, s.outlineAlpha);
        g.lineWidth = s.outline * 2 * k;
        eachWord((w, x) => g.strokeText(w.text, x, y));
      }
    }
    eachWord((w, x) => {
      g.fillStyle = rgba(w.highlight ? s.highlight : s.color);
      g.fillText(w.text, x, y);
    });
  });
}

/**
 * Renders the events to `<dir>/captions/*.png` and writes `<dir>/captions.ffconcat`.
 * Returns the ffconcat path relative to `dir`, or null if there is nothing to draw.
 */
export async function renderCaptionImages(
  dir: string,
  canvas: { width: number; height: number },
  events: CaptionEvent[],
  total: number,
  fontsDir: string | null,
): Promise<string | null> {
  if (!events.length) return null;
  if (fontsDir && existsSync(fontsDir) && !loadedFontDirs.has(fontsDir)) {
    GlobalFonts.loadFontsFromDir(fontsDir);
    loadedFontDirs.add(fontsDir);
  }
  const { width: W, height: H } = canvas;
  const out = join(dir, "captions");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // Split the timeline wherever anything appears or disappears.
  const cuts = [...new Set([0, total, ...events.flatMap((e) => [e.start, e.end])].map((t) => Math.round(t * 1000) / 1000))]
    .filter((t) => t >= 0 && t <= total)
    .sort((a, b) => a - b);

  const blank = "captions/blank.png";
  writeFileSync(join(dir, blank), await createCanvas(W, H).encode("png"));

  const images = new Map<string, string>();
  const list = ["ffconcat version 1.0"];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i]!;
    const b = cuts[i + 1]!;
    if (b - a < 0.0005) continue;
    const active = events.filter((e) => e.start <= a + 0.0005 && e.end >= b - 0.0005).sort((x, y) => x.layer - y.layer);
    let file = blank;
    if (active.length) {
      const key = JSON.stringify(active.map((e) => [e.parts, e.style, e.placement]));
      file = images.get(key) ?? "";
      if (!file) {
        const c = createCanvas(W, H);
        const g = c.getContext("2d");
        for (const e of active) drawEvent(g, e, W, H);
        file = `captions/${String(images.size).padStart(4, "0")}.png`;
        writeFileSync(join(dir, file), await c.encode("png"));
        images.set(key, file);
      }
    }
    list.push(`file '${file}'`, `duration ${(b - a).toFixed(3)}`);
  }
  // The concat demuxer ignores the last entry's duration, so repeat a blank.
  list.push(`file '${blank}'`);
  writeFileSync(join(dir, "captions.ffconcat"), `${list.join("\n")}\n`);
  return "captions.ffconcat";
}

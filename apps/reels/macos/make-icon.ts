// Renders an SVG logo into a macOS .icns file (no Xcode tools needed).
//   bun macos/make-icon.ts <icon.svg> <out.icns> [preview.png]
import { readFileSync, writeFileSync } from "node:fs";

import { createCanvas, loadImage } from "@napi-rs/canvas";

const [svgPath, outPath, previewPath] = process.argv.slice(2);
if (!svgPath || !outPath) throw new Error("Usage: bun macos/make-icon.ts <icon.svg> <out.icns> [preview.png]");

const svg = await loadImage(readFileSync(svgPath));

/** macOS icon grid: the artwork fills ~80% of the canvas, centered, with a soft shadow. */
async function render(size: number): Promise<Buffer> {
  const canvas = createCanvas(size, size);
  const g = canvas.getContext("2d");
  const body = size * 0.805;
  const offset = (size - body) / 2;
  g.shadowColor = "rgba(0, 0, 0, 0.28)";
  g.shadowBlur = size * 0.025;
  g.shadowOffsetY = size * 0.012;
  g.drawImage(svg, offset, offset - size * 0.006, body, body);
  return canvas.encode("png");
}

// icns entry types and their pixel sizes (PNG payloads).
const entries: [string, number][] = [
  ["icp4", 16],
  ["icp5", 32],
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
];

const chunks: Buffer[] = [];
for (const [type, size] of entries) {
  const png = await render(size);
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(png.length + 8, 4);
  chunks.push(header, png);
}
const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write("icns", 0, "ascii");
header.writeUInt32BE(body.length + 8, 4);
writeFileSync(outPath, Buffer.concat([header, body]));
if (previewPath) writeFileSync(previewPath, await render(512));
console.log(`Wrote ${outPath}`);

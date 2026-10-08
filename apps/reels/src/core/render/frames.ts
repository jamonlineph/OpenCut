import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ffmpegBin, runOrThrow } from "../exec";

/** Grabs single frames at the given times as JPEG bytes. */
export async function grabFrames(file: string, times: number[], width = 480): Promise<{ time: number; jpeg: Buffer }[]> {
  const dir = mkdtempSync(join(tmpdir(), "opencut-frames-"));
  try {
    return await Promise.all(
      times.map(async (time, i) => {
        const out = join(dir, `f${i}.jpg`);
        await runOrThrow([
          ffmpegBin(), "-y", "-v", "error", "-ss", String(Math.max(0, time)), "-i", file,
          "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4", out,
        ]);
        return { time, jpeg: readFileSync(out) };
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One image with a grid of frames taken every `every` seconds. Much cheaper for
 * an agent to look at than many separate frames.
 */
export async function contactSheet(file: string, duration: number, every: number, columns = 5): Promise<{ jpeg: Buffer; times: number[] }> {
  const count = Math.max(1, Math.min(30, Math.floor(duration / every)));
  const step = duration / count;
  const times = Array.from({ length: count }, (_, i) => Math.round((i + 0.5) * step * 10) / 10);
  const frames = await grabFrames(file, times, 216);
  const dir = mkdtempSync(join(tmpdir(), "opencut-sheet-"));
  try {
    frames.forEach((f, i) => writeFileSync(join(dir, `${String(i).padStart(3, "0")}.jpg`), f.jpeg));
    const rows = Math.ceil(count / columns);
    const out = join(dir, "sheet.jpg");
    await runOrThrow([
      ffmpegBin(), "-y", "-v", "error", "-framerate", "1", "-i", join(dir, "%03d.jpg"),
      "-vf", `scale=216:-2,tile=${Math.min(columns, count)}x${rows}:padding=4:color=black`, "-frames:v", "1", "-q:v", "4", out,
    ]);
    return { jpeg: readFileSync(out), times };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { capabilities, pickEncoder } from "../capabilities";
import { ffmpegBin, run } from "../exec";
import { editContext, isAnalyzed, loadProject, projectDir, readState, writeState } from "../project";
import { frameSnap, placeClips } from "../timeline";
import type { Workspace } from "../workspace";
import { renderCaptionImages } from "./caption-images";
import { buildCaptionEvents, toAss } from "./captions";
import { buildRenderPlan, type GraphOptions, type Quality } from "./graph";

export type RenderResult = { output: string; duration: number; seconds: number; warnings: string[] };

const active = new Map<string, Promise<RenderResult>>();

export function isRendering(projectId: string) {
  return active.has(projectId);
}

/** Renders the project's current revision. Progress goes to state.json. */
export function renderProject(ws: Workspace, projectId: string, quality: Quality): Promise<RenderResult> {
  const running = active.get(projectId);
  if (running) return running;
  const job = doRender(ws, projectId, quality).finally(() => active.delete(projectId));
  active.set(projectId, job);
  return job;
}

async function doRender(ws: Workspace, projectId: string, quality: Quality): Promise<RenderResult> {
  const project = loadProject(ws, projectId);
  const dir = projectDir(ws, projectId);
  const startedAt = new Date();
  const outputRel = `renders/r${project.revision}-${quality}.mp4`;
  writeState(ws, projectId, { render: { status: "running", progress: 0, quality, startedAt: startedAt.toISOString() } });

  try {
    if (!isAnalyzed(ws, project)) throw new Error("Analysis is still running. Wait for it to finish, then render.");
    const ctx = editContext(ws, project);
    const caps = await capabilities();
    const encoder = await pickEncoder(ws);

    const snapped = { ...project, clips: project.clips.map((c) => frameSnap(c, project.canvas.fps)) };
    const placed = placeClips(snapped);
    const total = placed.at(-1)?.outEnd ?? 0;
    const events = buildCaptionEvents(snapped, ctx, placed, total);
    const hasFonts = existsSync(ws.fonts) && readdirSync(ws.fonts).some((f) => /\.(ttf|otf)$/i.test(f));
    const fontsDir = hasFonts ? ws.fonts : null;
    // libass draws captions natively when FFmpeg has it; otherwise draw them ourselves.
    const useLibass = caps.captions && process.env.OPENCUT_CAPTIONS !== "images";
    let captions: GraphOptions["captions"] = null;
    if (events.length && useLibass) {
      writeFileSync(join(dir, "captions.ass"), toAss(project.canvas, events));
      captions = { kind: "ass", file: "captions.ass", fontsDir };
    } else if (events.length) {
      const file = await renderCaptionImages(dir, project.canvas, events, total, fontsDir);
      if (file) captions = { kind: "images", file };
    }

    const plan = buildRenderPlan(project, ctx, {
      quality,
      captions,
      encoder,
      tonemap: caps.tonemap ? "zscale" : "colorspace",
      output: outputRel,
    });
    // The exact command, runnable from the project folder, for debugging.
    const sh = (a: string) => (/^[\w./:=+-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
    writeFileSync(join(dir, "last-render.sh"), `cd ${sh(dir)} && ${[ffmpegBin(), ...plan.args].map(sh).join(" ")}\n`);

    let lastWrite = 0;
    const result = await run([ffmpegBin(), ...plan.args], {
      cwd: dir,
      onStdout: (chunk) => {
        const us = [...chunk.matchAll(/out_time_us=(\d+)/g)].pop();
        if (!us || Date.now() - lastWrite < 400) return;
        lastWrite = Date.now();
        const progress = Math.min(0.99, Number(us[1]) / 1e6 / plan.duration);
        writeState(ws, projectId, { render: { ...readState(ws, projectId).render, progress } });
      },
    });
    if (result.code !== 0) {
      const tail = result.stderr.trim().split("\n").slice(-12).join("\n");
      throw new Error(`FFmpeg failed:\n${tail}`);
    }
    const seconds = (Date.now() - startedAt.getTime()) / 1000;
    writeState(ws, projectId, {
      render: { status: "done", progress: 1, quality, output: outputRel, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString() },
    });
    return { output: join(dir, outputRel), duration: plan.duration, seconds, warnings: plan.warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeState(ws, projectId, { render: { status: "error", progress: 0, quality, error: message, startedAt: startedAt.toISOString() } });
    throw error;
  }
}

export function listRenders(ws: Workspace, projectId: string) {
  const dir = join(projectDir(ws, projectId), "renders");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".mp4"))
    .map((f) => ({ file: `renders/${f}`, path: join(dir, f), size: statSync(join(dir, f)).size, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

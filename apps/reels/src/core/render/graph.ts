import type { Clip, OverlayLayout, Project } from "../schema";
import { frameSnap, placeClips, resolveTime, type AssetData, type EditContext } from "../timeline";

export type Quality = "preview" | "final";

export type GraphOptions = {
  quality: Quality;
  /** Captions and titles, as an ASS file for libass or a timed image list. Paths relative to the project folder. */
  captions: { kind: "ass"; file: string; fontsDir: string | null } | { kind: "images"; file: string } | null;
  encoder: "libx264" | "h264_videotoolbox";
  /** How to bring HDR (HLG/PQ) footage to normal video: exact with zscale, approximate with the built-in colorspace filter. */
  tonemap: "zscale" | "colorspace";
  output: string;
};

export type RenderPlan = { args: string[]; duration: number; warnings: string[] };

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

const TONEMAP = {
  zscale: "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p",
  // HLG is close to SDR gamma, so converting the BT.2020 colors alone gets most of the way there.
  colorspace: "format=yuv420p10le,colorspace=all=bt709:iall=bt2020:itrc=bt2020-10:fast=0,format=yuv420p",
};

/** The crop that fills the canvas from a source frame, honoring zoom and focus. */
export function cropRect(src: { width: number; height: number }, canvas: { width: number; height: number }, clip: Pick<Clip, "zoom" | "focusX" | "focusY">) {
  const target = canvas.width / canvas.height;
  let cw: number;
  let ch: number;
  if (src.width / src.height > target) {
    ch = src.height / clip.zoom;
    cw = ch * target;
  } else {
    cw = src.width / clip.zoom;
    ch = cw / target;
  }
  cw = Math.min(even(cw), src.width - (src.width % 2));
  ch = Math.min(even(ch), src.height - (src.height % 2));
  const x = Math.round(Math.min(Math.max(clip.focusX * src.width - cw / 2, 0), src.width - cw));
  const y = Math.round(Math.min(Math.max(clip.focusY * src.height - ch / 2, 0), src.height - ch));
  return { cw, ch, x, y };
}

function layoutBox(layout: OverlayLayout, W: number, H: number) {
  switch (layout) {
    case "full":
      return { x: 0, y: 0, w: W, h: H, cover: true };
    case "top":
      return { x: 0, y: 0, w: W, h: even(H / 2), cover: true };
    case "bottom":
      return { x: 0, y: even(H / 2), w: W, h: even(H / 2), cover: true };
    case "center":
      return { x: even(W * 0.07), y: even(H * 0.14), w: even(W * 0.86), h: even(H * 0.42), cover: false };
    case "pip":
      return { x: even(W * 0.56), y: even(H * 0.13), w: even(W * 0.4), h: even(H * 0.26), cover: false };
  }
}

/** Groups clips into runs that read one source forward, so each run needs one decoder. */
export function runsOf(clips: Clip[]): Clip[][] {
  const runs: Clip[][] = [];
  for (const clip of clips) {
    const run = runs[runs.length - 1];
    const last = run?.[run.length - 1];
    if (run && last && last.asset === clip.asset && clip.in >= last.out - 0.001) run.push(clip);
    else runs.push([clip]);
  }
  return runs;
}

export function buildRenderPlan(project: Project, ctx: EditContext, options: GraphOptions): RenderPlan {
  const { width: W, height: H, fps } = project.canvas;
  const warnings: string[] = [];
  const clips = project.clips.map((c) => frameSnap(c, fps));
  if (!clips.length) throw new Error("Nothing to render: the project has no clips.");
  const placed = placeClips({ ...project, clips });
  const total = placed[placed.length - 1]!.outEnd;

  const inputs: string[] = [];
  const graph: string[] = [];
  let inputCount = 0;
  const addInput = (args: string[]) => {
    inputs.push(...args);
    return inputCount++;
  };
  const asset = (id: string): AssetData => {
    const a = ctx.assets.get(id);
    if (!a?.ready) throw new Error(`Asset ${id} has not been analyzed yet.`);
    return a;
  };

  // 1. Main track: every clip trimmed, framed for vertical, then concatenated.
  const segments: string[] = [];
  let k = 0;
  for (const run of runsOf(clips)) {
    const a = asset(run[0]!.asset);
    const runStart = Math.max(0, run[0]!.in - 0.1);
    const runEnd = run[run.length - 1]!.out + 0.2;
    const input = addInput(["-ss", n(runStart), "-t", n(runEnd - runStart), "-i", a.source]);
    if (a.hdr && options.tonemap === "colorspace") warnings.push("HDR footage converted approximately; for exact colors install an FFmpeg with zimg, or turn off HDR Video on your iPhone.");

    for (const clip of run) {
      const d = clip.out - clip.in;
      const frames = Math.round(d * fps);
      const from = clip.in - runStart;
      const pre = [
        `trim=start=${n(from)}:end=${n(from + d + 0.1)}`,
        "setpts=PTS-STARTPTS",
        `fps=${fps}`,
        `trim=end_frame=${frames}`,
        ...(a.hdr ? [TONEMAP[options.tonemap]] : []),
      ].join(",");

      if (project.canvas.fill === "blur" && a.width / a.height > W / H + 0.01) {
        const z = { width: even(a.width / clip.zoom), height: even(a.height / clip.zoom) };
        const zx = Math.round(Math.min(Math.max(clip.focusX * a.width - z.width / 2, 0), a.width - z.width));
        const zy = Math.round(Math.min(Math.max(clip.focusY * a.height - z.height / 2, 0), a.height - z.height));
        graph.push(`[${input}:v]${pre},crop=${z.width}:${z.height}:${zx}:${zy},split=2[bg${k}][fg${k}]`);
        graph.push(`[bg${k}]scale=${even(W / 4)}:${even(H / 4)}:force_original_aspect_ratio=increase,crop=${even(W / 4)}:${even(H / 4)},gblur=sigma=10,scale=${W}:${H}[bgs${k}]`);
        graph.push(`[fg${k}]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fgs${k}]`);
        graph.push(`[bgs${k}][fgs${k}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v${k}]`);
      } else {
        const r = cropRect(a, { width: W, height: H }, clip);
        graph.push(`[${input}:v]${pre},crop=${r.cw}:${r.ch}:${r.x}:${r.y},scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p[v${k}]`);
      }

      const exact = frames / fps;
      const audioFmt = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
      if (a.hasAudio) {
        graph.push(
          `[${input}:a]atrim=start=${n(from)}:end=${n(from + exact)},asetpts=PTS-STARTPTS,${audioFmt},apad=whole_dur=${n(exact)},atrim=end=${n(exact)},` +
            `afade=t=in:d=0.012,afade=t=out:st=${n(Math.max(0, exact - 0.012))}:d=0.012[a${k}]`,
        );
      } else {
        graph.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${n(exact)},${audioFmt}[a${k}]`);
      }
      segments.push(`[v${k}][a${k}]`);
      k++;
    }
  }
  graph.push(`${segments.join("")}concat=n=${k}:v=1:a=1[vbase0][voice]`);

  // 2. Image and B-roll overlays.
  let base = "vbase0";
  project.overlays.forEach((o, i) => {
    const start = resolveTime(o.start, "start", ctx, placed);
    const endRaw = resolveTime(o.end, "end", ctx, placed);
    if (start === null || endRaw === null) {
      warnings.push(`Overlay ${o.id} skipped: its words were cut.`);
      return;
    }
    const end = Math.min(endRaw, total);
    if (end - start < 0.1) {
      warnings.push(`Overlay ${o.id} skipped: it ends before it starts.`);
      return;
    }
    const a = asset(o.asset);
    const isVideo = project.assets.find((x) => x.id === o.asset)?.kind === "video";
    const input = isVideo
      ? addInput(["-ss", n(o.sourceStart), "-t", n(end - start + 0.2), "-i", a.source])
      : addInput(["-loop", "1", "-framerate", String(fps), "-t", n(end + 0.1), "-i", a.source]);
    const box = layoutBox(o.layout, W, H);
    const fit = box.cover
      ? `scale=${box.w}:${box.h}:force_original_aspect_ratio=increase,crop=${box.w}:${box.h}`
      : `scale=${box.w}:${box.h}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
    const fadeD = Math.min(0.2, (end - start) / 4);
    const fades = o.fade
      ? `,fade=t=in:st=${n(start)}:d=${n(fadeD)}:alpha=1,fade=t=out:st=${n(end - fadeD)}:d=${n(fadeD)}:alpha=1`
      : "";
    const timing = isVideo ? `fps=${fps},setpts=PTS-STARTPTS+${n(start)}/TB,` : "";
    graph.push(`[${input}:v]${timing}${fit},setsar=1,format=yuva420p${fades}[ov${i}]`);
    const x = box.cover ? String(box.x) : `'${box.x}+(${box.w}-w)/2'`;
    const y = box.cover ? String(box.y) : `'${box.y}+(${box.h}-h)/2'`;
    graph.push(`[${base}][ov${i}]overlay=x=${x}:y=${y}:enable='between(t,${n(start)},${n(end)})':eof_action=pass[vbase${i + 1}]`);
    base = `vbase${i + 1}`;
  });

  // 3. Captions and on-screen text.
  const tail: string[] = [];
  const caps = options.captions;
  if (caps?.kind === "ass") {
    tail.push(`ass=filename=${caps.file}${caps.fontsDir ? `:fontsdir=${quote(caps.fontsDir)}` : ""}`);
  } else if (caps?.kind === "images") {
    const input = addInput(["-f", "concat", "-safe", "0", "-i", caps.file]);
    graph.push(`[${input}:v]format=rgba[captions]`);
    graph.push(`[${base}][captions]overlay=0:0:format=auto:eof_action=pass[vcaptioned]`);
    base = "vcaptioned";
  }
  if (options.quality === "preview") tail.push(`scale=${even(W / 2)}:${even(H / 2)}`);
  graph.push(`[${base}]${tail.length ? tail.join(",") : "null"}[vout]`);

  // 4. Audio: music under the voice, then loudness to social-media level.
  let voice = "voice";
  const music = project.audio.music;
  if (music) {
    const m = asset(music.asset);
    const input = addInput(["-stream_loop", "-1", "-i", m.source]);
    const fadeOut = Math.min(2, total / 4);
    graph.push(
      `[${input}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=${n(total)},volume=${music.volumeDb}dB,` +
        `afade=t=out:st=${n(total - fadeOut)}:d=${n(fadeOut)}[mus]`,
    );
    if (music.duck) {
      graph.push(`[voice]asplit=2[voicemix][voicekey]`);
      graph.push(`[mus][voicekey]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[musduck]`);
      graph.push(`[voicemix][musduck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]`);
    } else {
      graph.push(`[voice][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]`);
    }
    voice = "mixed";
  }
  // loudnorm turns pure silence into NaNs, so only normalize when something makes sound.
  const audible = Boolean(music) || clips.some((c) => ctx.assets.get(c.asset)?.audible);
  graph.push(
    project.audio.normalize && audible
      ? `[${voice}]loudnorm=I=${project.audio.targetLufs}:TP=-1.5:LRA=11,aresample=48000[aout]`
      : `[${voice}]anull[aout]`,
  );

  const video =
    options.encoder === "libx264"
      ? ["-c:v", "libx264", "-preset", options.quality === "final" ? "medium" : "ultrafast", "-crf", options.quality === "final" ? "19" : "27", "-profile:v", "high"]
      : // allow_sw: Apple's software encoder when there is no hardware one (e.g. in a VM).
        ["-c:v", "h264_videotoolbox", "-b:v", options.quality === "final" ? "14M" : "5M", "-profile:v", "high", "-allow_sw", "1"];

  return {
    duration: total,
    warnings,
    args: [
      "-y",
      "-hide_banner",
      "-nostats",
      "-progress",
      "pipe:1",
      ...inputs,
      "-filter_complex",
      graph.join(";\n"),
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      ...video,
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(fps),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "-t",
      n(total),
      options.output,
    ],
  };
}

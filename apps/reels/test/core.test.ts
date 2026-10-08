import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { subtract, union } from "../src/core/intervals";
import { applyEdits } from "../src/core/ops";
import { renderCaptionImages } from "../src/core/render/caption-images";
import { buildCaptionEvents, captionChunks, toAss } from "../src/core/render/captions";
import { buildRenderPlan, cropRect, runsOf } from "../src/core/render/graph";
import { keptWordIds, keptWords, placeClips, resolveTime, totalDuration } from "../src/core/timeline";
import { formatTranscript } from "../src/core/transcript-view";
import { alignToSpeech, speechRegions } from "../src/core/align";
import { dtwPreset, parseWhisperJson } from "../src/core/transcribe";
import { fixture, SETTINGS, testWorkspace } from "./fixtures";

const ws = testWorkspace();

describe("intervals", () => {
  test("subtract splits a range around cuts", () => {
    expect(subtract({ start: 0, end: 10 }, [{ start: 2, end: 3 }, { start: 5, end: 6 }])).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 10 },
    ]);
    expect(subtract({ start: 2, end: 4 }, [{ start: 0, end: 10 }])).toEqual([]);
  });
  test("union merges overlaps", () => {
    expect(union([{ start: 3, end: 5 }, { start: 0, end: 1 }, { start: 4, end: 6 }])).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 6 },
    ]);
  });
});

describe("whisper.cpp output", () => {
  test("merges sub-word tokens, attaches punctuation and skips special tokens", () => {
    const parsed = parseWhisperJson({
      result: { language: "en" },
      transcription: [
        {
          offsets: { from: 0, to: 2000 },
          text: " Hello world, um yes.",
          tokens: [
            { text: "[_BEG_]", offsets: { from: 0, to: 0 } },
            { text: " Hel", offsets: { from: 100, to: 300 } },
            { text: "lo", offsets: { from: 300, to: 500 } },
            { text: " world", offsets: { from: 600, to: 900 } },
            { text: ",", offsets: { from: 900, to: 900 } },
            { text: " um", offsets: { from: 1100, to: 1300 } },
            { text: " yes", offsets: { from: 1500, to: 1800 } },
            { text: ".", offsets: { from: 1800, to: 1800 } },
            { text: "[_TT_90]", offsets: { from: 1800, to: 1800 } },
          ],
        },
      ],
    });
    expect(parsed.language).toBe("en");
    expect(parsed.words.map((w) => w.text)).toEqual(["Hello", "world,", "um", "yes."]);
    expect(parsed.words[0]).toMatchObject({ start: 0.1, end: 0.5 });
    expect(parsed.words[2]!.filler).toBe(true);
    expect(parsed.words[1]!.filler).toBeUndefined();
  });

  test("spreads words over the segment when tokens have no timing", () => {
    const parsed = parseWhisperJson({ transcription: [{ offsets: { from: 0, to: 1000 }, text: " ab cd" }] });
    expect(parsed.words.map((w) => [w.text, w.start, w.end])).toEqual([
      ["ab", 0, 0.5],
      ["cd", 0.5, 1],
    ]);
  });

  test("uses DTW timestamps for word starts when present", () => {
    const tok = (text: string, from: number, to: number, dtw: number) => ({ text, offsets: { from, to }, t_dtw: dtw });
    const parsed = parseWhisperJson({
      transcription: [
        { offsets: { from: 0, to: 3000 }, text: " Hi there.", tokens: [tok(" Hi", 0, 900, 52), tok(" there", 900, 2400, 95), tok(".", 2400, 2400, 140)] },
      ],
    });
    expect(parsed.words.map((w) => [w.text, w.start])).toEqual([["Hi", 0.52], ["there.", 0.95]]);
    // A word runs toward the next one, capped by its length so pauses aren't swallowed.
    expect(parsed.words[0]!.end).toBeGreaterThan(0.52);
    expect(parsed.words[0]!.end).toBeLessThanOrEqual(0.95);
  });

  test("picks the DTW preset from the model file name", () => {
    expect(dtwPreset("ggml-large-v3-turbo-q5_0.bin")).toBe("large.v3.turbo");
    expect(dtwPreset("ggml-base.en.bin")).toBe("base.en");
    expect(dtwPreset("ggml-small.bin")).toBe("small");
    expect(dtwPreset("my-model.bin")).toBeNull();
  });

  const say = (text: string, from: number, to: number) => {
    const list = text.split(" ");
    const d = (to - from) / list.length;
    return list.map((t, i) => ({ text: t, start: from + i * d, end: from + (i + 1) * d }));
  };

  test("speech regions are the gaps between silences", () => {
    expect(speechRegions([{ start: 0, end: 0.8 }, { start: 3, end: 4.5 }], 6)).toEqual([
      { start: 0.8, end: 3 },
      { start: 4.5, end: 6 },
    ]);
  });

  test("words drifting into pauses are moved into the speech", () => {
    const silences = [{ start: 0, end: 0.8 }, { start: 3.0, end: 4.5 }];
    const { words } = alignToSpeech(
      [
        { text: "Hey", start: 0.1, end: 0.4 }, // stamped in the leading pause
        { text: "everyone,", start: 0.9, end: 1.4 },
        { text: "my", start: 2.6, end: 2.9 },
        { text: "videos.", start: 3.1, end: 3.5 }, // drifted into the pause after the sentence
        { text: "Next", start: 4.6, end: 4.9 },
      ],
      silences,
      6,
    );
    for (const w of words) {
      const inSpeech = (w.start >= 0.8 && w.end <= 3.0) || (w.start >= 4.5 && w.end <= 6);
      expect(inSpeech).toBe(true);
    }
    expect(words.map((w) => w.start)).toEqual([...words.map((w) => w.start)].sort((a, b) => a - b));
    expect(words[4]!.start).toBeGreaterThanOrEqual(4.5);
  });

  test("a filler stamped onto its neighbour gets its own stretch of sound back", () => {
    // Real whisper.cpp output from CI: "Umm" was timed on top of "everyone", while
    // its audio is the short burst of sound between the two sentences.
    const silences = [
      { start: 0, end: 0.7 },
      { start: 1.6, end: 2.3 },
      { start: 2.7, end: 2.9 },
      { start: 6.5, end: 8 },
    ];
    const { words, unmatched } = alignToSpeech(
      [
        { text: "Hey", start: 0.74, end: 1.16 },
        { text: "everyone!", start: 0.74, end: 1.54 },
        { text: "Umm,", start: 0.97, end: 1.54, filler: true },
        ...say("today I want to show you how I edit my videos.", 2.96, 6.38),
      ],
      silences,
      8,
    );
    expect(words[2]).toMatchObject({ text: "Umm,", start: 2.3, end: 2.7, guessed: true });
    expect(words[1]!.end).toBeLessThanOrEqual(1.6);
    expect(words[3]!.start).toBeGreaterThanOrEqual(2.9);
    expect(unmatched).toEqual([]);
  });

  // Real whisper.cpp (base.en) output for the macOS CI clip, with the silences
  // FFmpeg found. Whisper put "Umm" in the middle of a pause and "today I" on the
  // um's own sound, and stretched "videos.", "silences." and "word." over the
  // pauses after them.
  const CI_WORDS: [string, number, number, number][] = [["Hey",0,0.42,0],["everyone!",0.74,2,0],["Umm,",2,2.57,1],["today",2.95,3.15,0],["I",3.15,3.23,0],["want",3.72,3.74,0],["to",3.79,3.95,0],["show",3.95,4.41,0],["you",4.41,4.76,0],["how",4.76,5.11,0],["I",5.11,5.22,0],["edit",5.22,5.68,0],["my",5.68,5.91,0],["videos.",5.91,8.18,0],["So",8.18,8.32,0],["the",8.32,8.53,0],["first",8.89,8.91,0],["thing,",8.92,9.42,0],["so",9.42,9.62,0],["the",9.62,9.71,0],["first",9.91,10.42,0],["thing",10.42,10.92,0],["is",11.12,11.14,0],["to",11.14,11.32,0],["cut",11.32,11.42,0],["out",11.92,11.94,0],["all",11.97,12.22,0],["the",12.22,12.52,0],["silences.",12.52,13.67,0],["The",13.68,13.76,0],["second",13.81,14.07,0],["thing",14.07,14.3,0],["is",14.3,14.5,0],["adding",15.04,15.09,0],["captions",15.09,15.82,0],["to",16.08,16.1,0],["every",16.08,16.58,0],["word.",16.58,17.3,0],["Follow",17.3,17.53,0],["for",17.53,17.93,0],["more",18.09,18.21,0],["tips.",18.24,18.54,0]];
  const CI_SILENCES = [[0,0.744],[1.541,2.96],[3.247,3.788],[6.378,8.027],[9.05,9.683],[12.368,13.62],[16.037,17.28],[18.469,19.691]];

  test("real whisper output: every word lands in the stretch of speech it was said in", () => {
    const { words, unmatched } = alignToSpeech(
      CI_WORDS.map(([text, start, end, filler]) => ({ text, start, end, filler: filler === 1 })),
      CI_SILENCES.map(([start, end]) => ({ start: start!, end: end! })),
      21.333,
    );
    // What the clip actually says between each pair of pauses.
    const regions = speechRegions(CI_SILENCES.map(([start, end]) => ({ start: start!, end: end! })), 21.333);
    const phrases = regions
      .map((r) => words.filter((w) => w.start >= r.start && w.end <= r.end).map((w) => w.text).join(" "))
      .filter(Boolean);
    expect(phrases).toEqual([
      "Hey everyone!",
      "Umm,",
      "today I want to show you how I edit my videos.",
      "So the first thing,",
      "so the first thing is to cut out all the silences.",
      "The second thing is adding captions to every word.",
      "Follow for more tips.",
    ]);
    expect(words[2]).toMatchObject({ start: 2.96, end: 3.247, guessed: true });
    expect(unmatched).toEqual([{ start: 19.691, end: 21.333 }]); // the audio ends before the video
  });

  test("wordless sound is reported so it can be cut", () => {
    const { unmatched } = alignToSpeech([{ text: "Hi.", start: 0.5, end: 0.9 }], [{ start: 1, end: 3 }], 4);
    expect(unmatched).toEqual([{ start: 3, end: 4 }]);
  });
});

describe("edit ops", () => {
  const edit = (ops: Parameters<typeof applyEdits>[2]) => {
    const { project, ctx } = fixture();
    return { ...applyEdits(ws, project, ops, ctx, SETTINGS), ctx };
  };
  const kept = (r: ReturnType<typeof edit>) => [...keptWordIds(r.ctx, placeClips(r.project))].sort((a, b) => a - b);

  test("remove_silences cuts long pauses but keeps every word", () => {
    const r = edit([{ op: "remove_silences" }]);
    expect(kept(r)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(totalDuration(r.project)).toBeLessThan(5);
    // The 0.2s pause (1.35-1.55) is below the 0.35s minimum, so it stays.
    expect(r.project.clips.some((c) => c.in <= 1.35 && c.out >= 1.55)).toBe(true);
    // Padding is kept before the first word.
    expect(r.project.clips[0]!.in).toBeCloseTo(0.87, 2);
  });

  test("remove_fillers drops um", () => {
    expect(kept(edit([{ op: "remove_fillers" }]))).toEqual([0, 2, 3, 4, 5, 6]);
  });

  test("a filler whose timing was guessed is only cut when it stands alone", () => {
    const run = (guessed: boolean, start: number) => {
      const { project, ctx } = fixture();
      Object.assign(ctx.words[1]!, { guessed, start }); // "um," right after "Hey" (ends 1.3)
      const r = applyEdits(ws, project, [{ op: "remove_fillers" }], ctx, SETTINGS);
      return { kept: [...keptWordIds(ctx, placeClips(r.project))].sort((a, b) => a - b), summary: r.summary.join(" ") };
    };
    expect(run(false, 1.3).kept).not.toContain(1); // Whisper's own timing: cut
    expect(run(true, 1.3)).toMatchObject({ kept: [0, 1, 2, 3, 4, 5, 6], summary: expect.stringContaining("1 with unsure timing") });
    expect(run(true, 1.6).kept).not.toContain(1); // pauses on both sides: it is its own burst of sound
  });

  test("a pause running into wordless noise is cut in one piece", () => {
    const { project, ctx } = fixture();
    const asset = ctx.assets.get("v1")!;
    asset.silences = [...asset.silences.slice(0, -1), { start: 5.95, end: 7.5 }];
    asset.noise = [{ start: 7.5, end: 10 }]; // e.g. the audio ends before the video
    const r = applyEdits(ws, project, [{ op: "remove_silences" }], ctx, SETTINGS).project;
    expect(r.clips.at(-1)!.out).toBeCloseTo(5.95 + SETTINGS.cutPadding, 3);
  });

  test("cut and restore are inverses for the words", () => {
    const { project, ctx } = fixture();
    const cut = applyEdits(ws, project, [{ op: "cut", from: 2, to: 4 }], ctx, SETTINGS);
    expect([...keptWordIds(ctx, placeClips(cut.project))]).toEqual([0, 1, 5, 6]);
    const back = applyEdits(ws, cut.project, [{ op: "restore", from: 2, to: 4 }], ctx, SETTINGS);
    expect([...keptWordIds(ctx, placeClips(back.project))].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("keep plays ranges in the order given", () => {
    const r = edit([{ op: "keep", ranges: [{ from: 5, to: 6 }, { from: 0, to: 0 }] }]);
    expect(keptWords(r.ctx, placeClips(r.project)).map((w) => w.id)).toEqual([5, 6, 0]);
  });

  test("move_to_start makes a hook without duplicating it", () => {
    const r = edit([{ op: "remove_silences" }, { op: "move_to_start", from: 5, to: 6 }]);
    const order = keptWords(r.ctx, placeClips(r.project)).map((w) => w.id);
    expect(order.slice(0, 2)).toEqual([5, 6]);
    expect(order.filter((id) => id === 5)).toHaveLength(1);
  });

  test("cut_time removes a span of the finished reel", () => {
    const r = edit([{ op: "cut_time", start: 2, end: 3 }]);
    expect(totalDuration(r.project)).toBeCloseTo(9, 1);
  });

  test("auto_zoom alternates punch-ins", () => {
    const r = edit([{ op: "remove_silences" }, { op: "auto_zoom" }]);
    expect(r.project.clips.map((c) => c.zoom)).toEqual(r.project.clips.map((_, i) => (i % 2 ? 1.12 : 1)));
  });

  test("text without an end lasts about 2.5s, ending on a word", () => {
    const r = edit([{ op: "add_text", text: "Hook", from: 0 }]);
    const t = r.project.texts[0]!;
    expect(t.start).toEqual({ word: 0 });
    expect(t.end).toEqual({ word: 4, edge: "end" }); // "talk." starts 2.2s after "Hey"
  });

  test("word-anchored items follow later cuts", () => {
    const { project, ctx } = fixture();
    const a = applyEdits(ws, project, [{ op: "add_text", text: "Point", from: 5, to: 6 }], ctx, SETTINGS);
    const before = resolveTime(a.project.texts[0]!.start, "start", ctx, placeClips(a.project))!;
    const b = applyEdits(ws, a.project, [{ op: "remove_silences" }], ctx, SETTINGS);
    const after = resolveTime(b.project.texts[0]!.start, "start", ctx, placeClips(b.project))!;
    expect(before).toBeCloseTo(5, 2);
    expect(after).toBeLessThan(before - 1);
  });

  test("bad word ids give a helpful error", () => {
    expect(() => edit([{ op: "cut", from: 50, to: 60 }])).toThrow(/Word #50 does not exist/);
  });
});

describe("rendering", () => {
  test("cropRect fills 9:16 from landscape and honors zoom and focus", () => {
    const canvas = { width: 1080, height: 1920 };
    expect(cropRect({ width: 1920, height: 1080 }, canvas, { zoom: 1, focusX: 0.5, focusY: 0.5 })).toEqual({ cw: 608, ch: 1080, x: 656, y: 0 });
    expect(cropRect({ width: 1920, height: 1080 }, canvas, { zoom: 1, focusX: 0, focusY: 0.5 }).x).toBe(0);
    const z = cropRect({ width: 1920, height: 1080 }, canvas, { zoom: 1.2, focusX: 0.5, focusY: 0.5 });
    expect(z.ch).toBe(900);
    expect(cropRect({ width: 1080, height: 1920 }, canvas, { zoom: 1, focusX: 0.5, focusY: 0.5 })).toEqual({ cw: 1080, ch: 1920, x: 0, y: 0 });
  });

  test("runsOf starts a new decoder only when the source jumps back", () => {
    const c = (id: string, i: number, o: number) => ({ id, asset: "v1", in: i, out: o, zoom: 1, focusX: 0.5, focusY: 0.5 });
    expect(runsOf([c("a", 5, 6), c("b", 0, 1), c("c", 2, 3)]).map((r) => r.map((x) => x.id))).toEqual([["a"], ["b", "c"]]);
  });

  test("captions group words, break on punctuation and skip fillers", () => {
    const { project, ctx } = fixture();
    const chunks = captionChunks(keptWords(ctx, placeClips(project)), 3);
    expect(chunks.map((c) => c.words.map((w) => w.text).join(" "))).toEqual(["Hey", "today we talk.", "Second point."]);
  });

  test("ASS output highlights each word and escapes braces", () => {
    const { project, ctx } = fixture();
    project.texts.push({ id: "t1", text: "{bad} \\ text", start: 0, end: 2, style: "hook", position: "top" });
    const events = buildCaptionEvents(project, ctx, placeClips(project), 10);
    expect(events).toHaveLength(7); // 6 spoken words + 1 title
    const ass = toAss(project.canvas, events);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("(bad) / text");
    expect(ass).not.toContain("{bad}");
    expect(ass).toContain("\\1c&H0000E6FF}TODAY");
  });

  test("built-in caption renderer writes a timed image list", async () => {
    const { project, ctx } = fixture();
    const events = buildCaptionEvents(project, ctx, placeClips(project), 10);
    const dir = mkdtempSync(join(tmpdir(), "opencut-caps-"));
    const file = await renderCaptionImages(dir, { width: 270, height: 480 }, events, 10, null);
    const list = readFileSync(join(dir, file!), "utf8").split("\n");
    const durations = list.filter((l) => l.startsWith("duration")).map((l) => Number(l.split(" ")[1]));
    expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 2);
    // Six distinct caption states (one per highlighted word), plus the blank frame.
    expect(readdirSync(join(dir, "captions"))).toHaveLength(7);
  });

  test("render plan wires cuts, overlays, captions and ducked music", () => {
    const { project, ctx } = fixture();
    const r = applyEdits(ws, project, [{ op: "remove_silences" }, { op: "move_to_start", from: 5, to: 6 }], ctx, SETTINGS).project;
    r.assets.push({ id: "img1", kind: "image", file: "inbox/p.png", name: "p.png" }, { id: "a1", kind: "audio", file: "inbox/m.mp3", name: "m.mp3" });
    ctx.assets.set("img1", { ...ctx.assets.get("v1")!, source: "/media/p.png", hasAudio: false, duration: 0 });
    ctx.assets.set("a1", { ...ctx.assets.get("v1")!, source: "/media/m.mp3", width: 0, height: 0 });
    r.overlays.push({ id: "o1", asset: "img1", start: 0.5, end: 2, layout: "pip", fade: true, sourceStart: 0 });
    r.audio.music = { asset: "a1", volumeDb: -20, duck: true };
    const plan = buildRenderPlan(r, ctx, { quality: "final", captions: { kind: "ass", file: "captions.ass", fontsDir: null }, encoder: "libx264", tonemap: "zscale", output: "out.mp4" });
    const graph = plan.args[plan.args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain(`concat=n=${r.clips.length}:v=1:a=1`);
    expect(graph).toContain("enable='between(t,0.5,2)'");
    expect(graph).toContain("ass=filename=captions.ass");
    expect(graph).toContain("sidechaincompress");
    expect(graph).toContain("loudnorm=I=-14");
    // The hook jumps back in the source, so it gets its own input.
    expect(plan.args.filter((a) => a === "-i")).toHaveLength(4);
    expect(plan.duration).toBeCloseTo(totalDuration(r), 1);
  });
});

describe("transcript view", () => {
  test("marks cut words and long pauses", () => {
    const { project, ctx } = fixture();
    const r = applyEdits(ws, project, [{ op: "remove_fillers" }], ctx, SETTINGS).project;
    const text = formatTranscript(r, ctx);
    expect(text).toContain("~~um,~~");
    expect(text).toContain("(pause 0.7s)");
    expect(text).toMatch(/#0-#4 \[1\.0s-3\.6s\]/);
  });
});

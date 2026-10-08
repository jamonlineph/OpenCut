import { describe, expect, test } from "bun:test";

import Anthropic from "@anthropic-ai/sdk";

import { planWithClaude } from "../src/core/director/claude";
import type { DirectorContext } from "../src/core/director/context";
import { directorTranscript } from "../src/core/director/context";
import { formatPublish, parsePublish, planToOps, projectToPlan, type ReelPlan } from "../src/core/director/plan";
import { applyEdits } from "../src/core/ops";
import { findRetakes } from "../src/core/retakes";
import { keptWords, placeClips, type PWord } from "../src/core/timeline";
import { fixture, SETTINGS, testWorkspace } from "./fixtures";

const ws = testWorkspace();

const plan = (over: Partial<ReelPlan> = {}): ReelPlan => ({
  name: "Second point",
  hook_title: "Wait for it",
  segments: [{ from: 5, to: 6 }, { from: 0, to: 4 }],
  overlays: [],
  caption_style: "clean",
  caption_position: "middle",
  focus_x: 0.3,
  punch_in_zooms: true,
  music: "",
  publish: { title: "A title", caption: "A caption", hashtags: ["editing", "#reels"] },
  ...over,
});

describe("retakes", () => {
  const timed = (texts: [string, number][]): ReturnType<typeof keptWords> =>
    texts.map(([text, start], id) => ({ id, asset: "v1", text, start, end: start + 0.2, outStart: start, outEnd: start + 0.2, clipIndex: 0 }));

  test("cuts a false start that restarts with the same words", () => {
    const words = timed([["So", 0], ["today", 0.25], ["I", 0.5], ["wa-", 0.7], ["So", 1.6], ["today", 1.85], ["I", 2.1], ["want", 2.3], ["coffee.", 2.6]]);
    expect(findRetakes(words)).toEqual([[0, 3]]);
  });

  test("cuts an earlier take of a repeated sentence", () => {
    const words = timed([["This", 0], ["is", 0.3], ["the", 0.6], ["best.", 0.9], ["This", 2], ["is", 2.3], ["the", 2.6], ["best", 2.9], ["tool.", 3.2]]);
    expect(findRetakes(words)).toEqual([[0, 3]]);
  });

  test("cuts an attempt and the 'sorry, again' between takes", () => {
    const words = timed([["Here's", 0], ["the", 0.3], ["thing", 0.6], ["um.", 0.9], ["Sorry,", 2], ["again.", 2.3], ["Here's", 3.5], ["the", 3.8], ["thing:", 4.1], ["focus.", 4.4]]);
    expect(findRetakes(words)).toEqual([[0, 3], [4, 5]]);
  });

  test("cuts a restart inside one sentence", () => {
    const words = timed([["So", 0], ["the", 0.2], ["first", 0.4], ["thing,", 0.6], ["so", 1.4], ["the", 1.6], ["first", 1.8], ["thing", 2.0], ["is", 2.2], ["silence.", 2.4]]);
    expect(findRetakes(words)).toEqual([[0, 3]]);
  });

  test("keeps parallel sentences that share a start", () => {
    const words = timed([
      ["I", 0], ["want", 0.2], ["to", 0.4], ["show", 0.6], ["you", 0.8], ["the", 1.0], ["cuts.", 1.2],
      ["I", 2.5], ["want", 2.7], ["to", 2.9], ["show", 3.1], ["you", 3.3], ["the", 3.5], ["captions", 3.7], ["and", 3.9], ["the", 4.1], ["music.", 4.3],
    ]);
    expect(findRetakes(words)).toEqual([]);
  });

  test("leaves normal speech alone", () => {
    const words = timed([["I", 0], ["love", 0.3], ["coffee.", 0.6], ["It", 1.5], ["keeps", 1.8], ["me", 2.1], ["going.", 2.4]]);
    expect(findRetakes(words)).toEqual([]);
  });

  test("the remove_retakes op keeps only the last take", () => {
    const { project, ctx } = fixture();
    const say = (text: string, start: number, id: number): PWord => ({ id, asset: "v1", text, start, end: start + 0.25 });
    ctx.words = [say("So", 1.0, 0), say("today", 1.3, 1), say("I", 1.6, 2), say("So", 3.0, 3), say("today", 3.3, 4), say("I", 3.6, 5), say("want.", 3.9, 6)];
    ctx.assets.get("v1")!.silences = [];
    const r = applyEdits(ws, project, [{ op: "remove_retakes" }], ctx, SETTINGS);
    expect(r.summary[0]).toContain("#0-#2");
    expect(keptWords(ctx, placeClips(r.project)).map((w) => w.id)).toEqual([3, 4, 5, 6]);
  });
});

describe("plan → edit ops", () => {
  test("builds a clean edit and drops what doesn't fit", () => {
    const { project, ctx } = fixture();
    const { ops, warnings } = planToOps(
      plan({
        segments: [{ from: 5, to: 6 }, { from: 99, to: 120 }, { from: 4, to: 0 }],
        overlays: [
          { file: "Photo.PNG", from: 5, to: 6, layout: "top" },
          { file: "missing.png", from: 0, to: 1, layout: "full" },
        ],
        music: "nope.mp3",
      }),
      project,
      ctx,
      { visuals: ["photo.png"], music: [] },
    );
    expect(ops.find((o) => o.op === "keep")).toEqual({ op: "keep", ranges: [{ from: 5, to: 6 }, { from: 0, to: 4 }] });
    expect(ops.find((o) => o.op === "add_overlay")).toMatchObject({ asset: "photo.png", from: 5, to: 6 });
    expect(ops.find((o) => o.op === "add_text")).toMatchObject({ text: "Wait for it", start: 0, end: 2.5 });
    expect(ops.find((o) => o.op === "frame")).toEqual({ op: "frame", focusX: 0.3 });
    expect(ops.find((o) => o.op === "notes")).toEqual({ op: "notes", text: "Title: A title\nCaption: A caption\nHashtags: #editing #reels" });
    expect(warnings).toHaveLength(3);
  });

  test("refuses a plan with nothing valid to keep", () => {
    const { project, ctx } = fixture();
    expect(() => planToOps(plan({ segments: [{ from: 50, to: 60 }] }), project, ctx, { visuals: [], music: [] })).toThrow(/no valid words/);
  });

  test("a project reads back as the plan that made it", () => {
    const { project, ctx } = fixture();
    const { ops } = planToOps(plan(), project, ctx, { visuals: [], music: [] });
    const edited = applyEdits(ws, project, ops.filter((o) => o.op !== "add_overlay"), ctx, SETTINGS).project;
    const back = projectToPlan(edited, ctx);
    expect(back.segments).toEqual([{ from: 5, to: 6 }, { from: 0, to: 4 }]);
    expect(back.hook_title).toBe("Wait for it");
    expect(back.caption_style).toBe("clean");
    expect(back.punch_in_zooms).toBe(true);
    expect(back.publish).toEqual({ title: "A title", caption: "A caption", hashtags: ["#editing", "#reels"] });
  });

  test("publish copy round-trips through project notes", () => {
    const p = { title: "T", caption: "C", hashtags: ["#a", "#b"] };
    expect(parsePublish(formatPublish(p))).toEqual(p);
  });

  test("director transcript gives every word an id and marks fillers and pauses", () => {
    const { project, ctx } = fixture();
    const t = directorTranscript(project, ctx);
    expect(t).toContain("(1.0s) 0|Hey 1|um,*");
    expect(t).toContain("[pause 1.4s]");
    expect(t).toContain("5|Second 6|point.");
  });
});

/** A Messages API streaming response (server-sent events) with one text block. */
function sse(text: string, stop: { reason: string; details?: unknown } = { reason: "end_turn" }) {
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ...(text
      ? ([
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ] as [string, unknown][])
      : []),
    ["message_delta", { type: "message_delta", delta: { stop_reason: stop.reason, stop_sequence: null, stop_details: stop.details ?? null }, usage: { output_tokens: 10 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("Claude director", () => {
  test("sends context with images and parses the structured plan", async () => {
    const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
    const answer = { summary: "A tip about editing.", reels: [plan()] };
    const fetchMock = async (_url: unknown, init?: RequestInit) => {
      requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return sse(JSON.stringify(answer));
    };
    const client = new Anthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const { project, ctx } = fixture();
    const dc: DirectorContext = {
      project,
      ctx,
      styleGuide: "# Style",
      facts: "Project id: t",
      transcript: directorTranscript(project, ctx),
      pictures: [{ label: "Frames:", jpeg: Buffer.from([0xff, 0xd8, 0xff]) }],
      visuals: [],
      music: [],
    };
    const result = await planWithClaude(client, "claude-opus-5-5", dc, 2);
    expect(result).toEqual(answer);

    const { headers, body } = requests[0]!;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.stream).toBe(true);
    expect(body.fallbacks).toBe("default");
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect((body.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    const content = (body.messages as { content: { type: string; text?: string }[] }[])[0]!.content;
    expect(content.some((b) => b.type === "image")).toBe(true);
    expect(content.some((b) => b.text?.includes("0|Hey"))).toBe(true);
    expect(content.at(-1)!.text).toContain("between 1 and 2 reel(s)");
  });

  test("a refusal becomes a clear error", async () => {
    const client = new Anthropic({
      apiKey: "test",
      fetch: (async () => sse("", { reason: "refusal", details: { type: "refusal", category: null, explanation: "nope" } })) as unknown as typeof fetch,
    });
    const { project, ctx } = fixture();
    const dc = { project, ctx, styleGuide: "", facts: "", transcript: "", pictures: [], visuals: [], music: [] };
    await expect(planWithClaude(client, "claude-opus-5-5", dc, 1)).rejects.toThrow(/declined/);
  });
});

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

import { SYSTEM_PROMPT, type DirectorContext } from "./context";
import { DirectorPlan, ReelPlan, ReviewResult } from "./plan";

// Director that calls the Claude API directly. Needs an API key
// (ANTHROPIC_API_KEY) or an `ant auth login` profile.

type Content = Anthropic.Beta.BetaContentBlockParam[];

const image = (jpeg: Buffer): Anthropic.Beta.BetaImageBlockParam => ({
  type: "image",
  source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") },
});

const text = (t: string): Anthropic.Beta.BetaTextBlockParam => ({ type: "text", text: t });

export class ClaudeDirectorError extends Error {}

async function ask<S extends z.ZodType>(client: Anthropic, model: string, schema: S, content: Content): Promise<z.infer<S>> {
  const response = await client.beta.messages.parse({
    model,
    // Thinking counts toward this, and a long video can yield several reels.
    max_tokens: 32000,
    // If a safety classifier declines, retry server-side on Anthropic's recommended model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: betaZodOutputFormat(schema) },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") {
    throw new ClaudeDirectorError(`Claude declined to edit this video${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : "."}`);
  }
  if (response.stop_reason === "max_tokens") throw new ClaudeDirectorError("Claude's answer was cut off (max_tokens).");
  if (!response.parsed_output) throw new ClaudeDirectorError("Claude's answer didn't match the plan format.");
  return response.parsed_output as z.infer<S>;
}

function contextBlocks(dc: DirectorContext, withPictures: boolean): Content {
  const blocks: Content = [text(`# Style guide\n${dc.styleGuide}\n\n# Facts\n${dc.facts}`)];
  if (withPictures) for (const p of dc.pictures) blocks.push(text(p.label), image(p.jpeg));
  blocks.push(text(`# Transcript (word id|word, * = filler, (time) = sentence start)\n${dc.transcript}`));
  return blocks;
}

export async function planWithClaude(client: Anthropic, model: string, dc: DirectorContext, maxReels: number): Promise<DirectorPlan> {
  return ask(client, model, DirectorPlan, [
    ...contextBlocks(dc, true),
    text(
      `Decide the edit. Make between 1 and ${maxReels} reel(s): more than one only if the footage holds several self-contained ideas that each make a good reel.`,
    ),
  ]);
}

export async function reviewWithClaude(
  client: Anthropic,
  model: string,
  dc: DirectorContext,
  plan: ReelPlan,
  render: { sheet: Buffer; times: number[]; duration: number },
): Promise<ReviewResult> {
  return ask(client, model, ReviewResult, [
    ...contextBlocks(dc, false),
    text(`# Your plan for this reel\n${JSON.stringify(plan, null, 2)}`),
    text(`# Preview render: ${render.duration.toFixed(1)}s. Frames at ${render.times.map((t) => `${t}s`).join(", ")} (left to right, top to bottom):`),
    image(render.sheet),
    text(
      "Check the preview like a picky editor: is the face visible in the vertical crop, do captions or titles cover the face, do overlays match what is being said, does the hook land in the first seconds, is the length right, does it end cleanly? " +
        "Words already cut from the reel are ~~struck~~ in the transcript. Approve it, or return a fixed plan.",
    ),
  ]);
}

export async function reviseWithClaude(client: Anthropic, model: string, dc: DirectorContext, current: ReelPlan, instruction: string): Promise<ReelPlan> {
  return ask(client, model, ReelPlan, [
    ...contextBlocks(dc, true),
    text(`# Current edit\n${JSON.stringify(current, null, 2)}\n\nWords currently cut are ~~struck~~ in the transcript.`),
    text(`# The creator asks\n${instruction}\n\nReturn the full updated plan. Change only what the request needs.`),
  ]);
}

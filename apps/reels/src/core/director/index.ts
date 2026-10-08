import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { analyzeProject, createProject, editContext, listProjects, loadProject, saveProject } from "../project";
import { contactSheet } from "../render/frames";
import { renderProject } from "../render/render";
import { probe } from "../probe";
import { AUTO_EDIT, editProject, listInbox } from "../service";
import { keptWords, placeClips } from "../timeline";
import { readSettings, type Workspace } from "../workspace";
import { agentAvailable, directPrompt, revisePrompt, runAgent, type AgentKind } from "./agent";
import { planWithClaude, reviewWithClaude, reviseWithClaude } from "./claude";
import { gatherContext } from "./context";
import { planToOps, projectToPlan, type ReelPlan } from "./plan";

export type DirectorName = "claude-api" | "claude-code" | "codex" | "basic";

export type DirectorOptions = {
  /** Short progress messages ("Planning the edit…"). */
  onStep?: (step: string) => void;
  /** Detailed log lines. */
  log?: (line: string) => void;
  /** Injected Claude client (tests). */
  client?: Anthropic;
  director?: DirectorName;
};

export type DirectResult = { director: DirectorName; projects: string[]; summary: string; warnings: string[] };

function hasClaudeApiCredentials() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || existsSync(join(homedir(), ".config", "anthropic")));
}

/** The director to use: the setting, or the best one this Mac has. */
export function pickDirector(ws: Workspace): DirectorName {
  const wanted = readSettings(ws).autopilot.director;
  if (wanted !== "auto") return wanted;
  if (hasClaudeApiCredentials()) return "claude-api";
  if (agentAvailable("claude-code")) return "claude-code";
  if (agentAvailable("codex")) return "codex";
  return "basic";
}

export function directorLabel(name: DirectorName): string {
  return { "claude-api": "Claude (API)", "claude-code": "Claude Code", codex: "Codex", basic: "Basic (no AI)" }[name];
}

async function applyPlan(ws: Workspace, projectId: string, plan: ReelPlan): Promise<string[]> {
  const project = loadProject(ws, projectId);
  const ctx = editContext(ws, project);
  const inbox = listInbox(ws);
  const available = {
    visuals: inbox.filter((i) => i.kind === "image" || (i.kind === "video" && i.file.startsWith("inbox/"))).map((i) => i.name),
    music: inbox.filter((i) => i.kind === "audio").map((i) => i.name),
  };
  const { ops, warnings } = planToOps(plan, project, ctx, available);
  await editProject(ws, projectId, ops);
  if (plan.name.trim()) {
    const named = loadProject(ws, projectId);
    named.name = plan.name.trim();
    saveProject(ws, named);
  }
  return warnings;
}

/** Projects created since `since` from the same videos, e.g. extra reels an agent cut. */
function siblingProjects(ws: Workspace, projectId: string, since: string): string[] {
  const files = new Set(loadProject(ws, projectId).assets.filter((a) => a.kind === "video").map((a) => a.file));
  return listProjects(ws)
    .filter((p) => p.id !== projectId && p.createdAt >= since && p.assets.some((a) => files.has(a.file)))
    .map((p) => p.id);
}

async function basicEdit(ws: Workspace, projectId: string): Promise<string> {
  const { summary } = await editProject(ws, projectId, AUTO_EDIT);
  const project = loadProject(ws, projectId);
  const ctx = editContext(ws, project);
  const words = keptWords(ctx, placeClips(project)).filter((w) => !w.filler);
  const firstSentence: string[] = [];
  for (const w of words) {
    firstSentence.push(w.text);
    if (/[.?!]$/.test(w.text) || firstSentence.length >= 10) break;
  }
  if (firstSentence.length) await editProject(ws, projectId, [{ op: "notes", text: `Title: ${firstSentence.join(" ").replace(/[.,]$/, "")}` }]);
  return summary.at(-1) ?? "Edited.";
}

/** Decides and applies the edit for a freshly analyzed project. May create extra reels. */
export async function directProject(ws: Workspace, projectId: string, options: DirectorOptions = {}): Promise<DirectResult> {
  const settings = readSettings(ws).autopilot;
  const director = options.director ?? pickDirector(ws);
  const step = options.onStep ?? (() => {});
  const log = options.log ?? (() => {});
  const startedAt = new Date().toISOString();

  if (director === "basic") {
    step("Editing (basic: silences, fillers, retakes, captions)…");
    return { director, projects: [projectId], summary: await basicEdit(ws, projectId), warnings: [] };
  }

  if (director === "claude-code" || director === "codex") {
    step(`${directorLabel(director)} is editing…`);
    // The agent looks at the footage itself through the MCP tools.
    const dc = await gatherContext(ws, projectId, { pictures: false });
    const output = await runAgent(ws, director as AgentKind, settings, directPrompt(projectId, dc.facts, settings.maxReels), log);
    return { director, projects: [projectId, ...siblingProjects(ws, projectId, startedAt)], summary: output.split("\n").slice(-6).join("\n"), warnings: [] };
  }

  // claude-api
  const client = options.client ?? new Anthropic();
  step("Understanding the video…");
  const dc = await gatherContext(ws, projectId);
  step("Planning the edit…");
  const plan = await planWithClaude(client, settings.model, dc, settings.maxReels);
  log(`Plan: ${plan.summary}`);
  const reels = plan.reels.slice(0, settings.maxReels);
  if (!reels.length) throw new Error("Claude returned no reels.");

  const projects: string[] = [];
  const warnings: string[] = [];
  const base = loadProject(ws, projectId);
  for (const [i, reel] of reels.entries()) {
    let id = projectId;
    if (i > 0) {
      const extra = createProject(ws, reel.name || `${base.name} ${i + 1}`, base.assets.filter((a) => a.kind === "video").map((a) => a.file));
      await analyzeProject(ws, extra); // cached: same videos
      if (base.brief) await editProject(ws, extra.id, [{ op: "brief", text: base.brief }]);
      id = extra.id;
    }
    step(`Editing reel ${i + 1} of ${reels.length}: ${reel.name}`);
    warnings.push(...(await applyPlan(ws, id, reel)));
    projects.push(id);

    if (settings.review) {
      step(`Checking reel ${i + 1}…`);
      const review = await reviewProject(ws, id, reel, client, settings.model);
      log(review.approved ? `Review: approved` : `Review: ${review.problems.join("; ")}`);
      if (!review.approved) warnings.push(...(await applyPlan(ws, id, review.revised)));
    }
  }
  warnings.forEach((w) => log(`warning: ${w}`));
  return { director, projects, summary: `${plan.summary}\n${reels.map((r) => `• ${r.name}: ${r.publish.title}`).join("\n")}`, warnings };
}

async function reviewProject(ws: Workspace, projectId: string, plan: ReelPlan, client: Anthropic, model: string) {
  const preview = await renderProject(ws, projectId, "preview");
  const { duration } = await probe(preview.output, "video");
  const sheet = await contactSheet(preview.output, duration, Math.max(1, duration / 10), 5);
  const dc = await gatherContext(ws, projectId, { showCuts: true });
  return reviewWithClaude(client, model, dc, plan, { sheet: sheet.jpeg, times: sheet.times, duration });
}

/** Changes an existing reel according to a plain-language request. */
export async function reviseProject(ws: Workspace, projectId: string, instruction: string, options: DirectorOptions = {}): Promise<DirectResult> {
  const settings = readSettings(ws).autopilot;
  const director = options.director ?? pickDirector(ws);
  const step = options.onStep ?? (() => {});
  const log = options.log ?? (() => {});

  if (director === "basic") {
    throw new Error("Asking the AI needs Claude Code, Codex or a Claude API key. Run `bun run doctor` to see what's set up.");
  }
  if (director === "claude-code" || director === "codex") {
    step(`${directorLabel(director)} is working on it…`);
    const output = await runAgent(ws, director, settings, revisePrompt(projectId, instruction), log);
    return { director, projects: [projectId], summary: output.split("\n").slice(-3).join("\n"), warnings: [] };
  }
  const client = options.client ?? new Anthropic();
  step("Claude is working on it…");
  const dc = await gatherContext(ws, projectId, { showCuts: true });
  const current = projectToPlan(dc.project, dc.ctx);
  const plan = await reviseWithClaude(client, settings.model, dc, current, instruction);
  const warnings = await applyPlan(ws, projectId, plan);
  return { director, projects: [projectId], summary: `Updated "${plan.name}".`, warnings };
}

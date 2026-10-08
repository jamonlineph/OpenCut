import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { approveJob, discardJob, groupDrops, listJobs, loadEnvFile, reviseJob, type Job } from "../src/core/autopilot";
import { writeJson } from "../src/core/workspace";
import { launchAgentPlist } from "../src/core/launchd";
import { testWorkspace } from "./fixtures";

describe("drop grouping", () => {
  test("folders are one reel, loose videos are one each, extras follow their video", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencut-drop-"));
    mkdirSync(join(dir, "trip"));
    for (const f of ["trip/a.mp4", "trip/b.png", "trip/notes.txt", "trip/.DS_Store", "talk.mov", "talk.txt", "other.mp4", "logo.png", "big.mp4.part", ".hidden.mp4"]) {
      writeFileSync(join(dir, f), "x");
    }
    const { groups, loose } = groupDrops(dir);
    const shape = groups.map((g) => [g.name, g.paths.map((p) => basename(p))]);
    expect(shape).toEqual([
      ["trip", ["a.mp4", "b.png", "notes.txt"]],
      ["other", ["other.mp4", "logo.png"]],
      ["talk", ["talk.mov", "talk.txt"]],
    ]);
    expect(loose).toEqual([]);
  });

  test("photos without a video are reported as loose", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencut-drop-"));
    writeFileSync(join(dir, "logo.png"), "x");
    const { groups, loose } = groupDrops(dir);
    expect(groups).toEqual([]);
    expect(loose.map((p) => basename(p))).toEqual(["logo.png"]);
  });
});

describe("environment", () => {
  test(".env in the workspace fills missing variables only", () => {
    const ws = testWorkspace();
    writeFileSync(join(ws.root, ".env"), 'OPENCUT_TEST_KEY="abc"\n# comment\nOPENCUT_TEST_KEEP=new\n');
    process.env.OPENCUT_TEST_KEEP = "old";
    loadEnvFile(ws);
    expect(process.env.OPENCUT_TEST_KEY).toBe("abc");
    expect(process.env.OPENCUT_TEST_KEEP).toBe("old");
  });

  test("the login agent runs the Studio with Homebrew on PATH", () => {
    const ws = testWorkspace();
    const plist = launchAgentPlist(ws);
    expect(plist).toContain("<string>app.opencut.studio</string>");
    expect(plist).toMatch(/studio[\\/]server\.ts<\/string>/);
    expect(plist).toContain("/opt/homebrew/bin");
    expect(plist).toContain(`<string>${ws.root}</string>`);
  });
});

describe("review before export", () => {
  const waiting = (ws: ReturnType<typeof testWorkspace>, status: Job["status"] = "review") => {
    const job: Job = {
      id: "20260101000000-talk",
      name: "talk",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      status,
      step: "Waiting for your OK",
      files: ["inbox/talk.mp4"],
      notes: "",
      projects: ["talk"],
      previews: [{ project: "talk", file: "projects/talk/renders/r3-preview.mp4", title: "Talk", caption: "", hashtags: [], duration: 12, revision: 3 }],
      outputs: [],
      log: [],
    };
    writeJson(join(ws.autopilot, "jobs", `${job.id}.json`), job);
    return job.id;
  };

  test("discarding keeps the job (and its reels) but stops it waiting", () => {
    const ws = testWorkspace();
    const id = waiting(ws);
    expect(discardJob(ws, id).status).toBe("discarded");
    expect(listJobs(ws)[0]).toMatchObject({ status: "discarded", projects: ["talk"] });
    expect(() => discardJob(ws, id)).toThrow("isn't waiting for review");
  });

  test("only jobs waiting for review can be approved, and only with their own reels", () => {
    const ws = testWorkspace();
    expect(() => approveJob(ws, waiting(ws, "done"))).toThrow("isn't waiting for review");
    const id = waiting(ws);
    expect(() => approveJob(ws, id, { projects: ["someone-else"] })).toThrow("Pick at least one reel");
  });

  test("a change request that fails leaves the reel waiting for review with the reason", async () => {
    const ws = testWorkspace();
    writeJson(ws.settingsFile, { autopilot: { director: "basic" } });
    const id = waiting(ws);
    await expect(reviseJob(ws, id, "talk", "punchier hook")).rejects.toThrow("needs Claude Code, Codex or a Claude API key");
    expect(listJobs(ws)[0]).toMatchObject({ status: "review", error: expect.stringContaining("needs Claude Code") });
    await expect(reviseJob(ws, id, "other", "x")).rejects.toThrow("isn't part of this job");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { groupDrops, loadEnvFile } from "../src/core/autopilot";
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

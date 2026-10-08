import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "../src/core/schema";
import type { EditContext, PWord } from "../src/core/timeline";
import { workspace } from "../src/core/workspace";

export const testWorkspace = () => workspace(mkdtempSync(join(tmpdir(), "opencut-test-")));

// "Hey [um] today we talk. ... Second point." with pauses between.
const raw: [string, number, number, boolean?][] = [
  ["Hey", 1.0, 1.3],
  ["um,", 1.6, 1.8, true],
  ["today", 2.5, 2.9],
  ["we", 3.0, 3.1],
  ["talk.", 3.2, 3.6],
  ["Second", 5.0, 5.4],
  ["point.", 5.5, 5.9],
];

export function fixture(): { project: Project; ctx: EditContext } {
  const words: PWord[] = raw.map(([text, start, end, filler], id) => ({ id, asset: "v1", text, start, end, filler }));
  const ctx: EditContext = {
    words,
    assets: new Map([
      [
        "v1",
        {
          ready: true,
          duration: 10,
          width: 1920,
          height: 1080,
          hasAudio: true,
          audible: true,
          hdr: false,
          source: "/media/talk.mp4",
          silences: [
            { start: 0, end: 0.95 },
            { start: 1.35, end: 1.55 },
            { start: 1.85, end: 2.45 },
            { start: 3.65, end: 4.95 },
            { start: 5.95, end: 10 },
          ],
        },
      ],
    ]),
  };
  const project = Project.parse({
    id: "t",
    name: "Test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    seq: 1,
    assets: [{ id: "v1", kind: "video", file: "inbox/talk.mp4", name: "talk.mp4" }],
    clips: [{ id: "c1", asset: "v1", in: 0, out: 10 }],
  });
  return { project, ctx };
}

export const SETTINGS = { minSilence: 0.35, cutPadding: 0.08 };

# OpenCut Reels

A fast, local editor for vertical short-form video (Reels, Shorts, TikTok), built
to be driven by an AI assistant. Drop your talking-head videos and images in, then
either click around in **OpenCut Studio** or ask Claude, Codex or Antigravity to
edit for you through the **MCP server**. Both work on the same projects at the
same time, and the Studio shows the AI's edits live.

What it does:

- **Transcribes your voice** on your Mac (whisper.cpp), with timing for every word
- **Cuts silences and filler words** ("um", "uh") automatically
- **Cuts by word**: delete a sentence, keep the best take, move the best line to the start as the hook
- **Captions** that highlight each word as you say it (bold, clean or minimal styles)
- **Vertical 9:16 framing** from any video, with punch-in zooms to hide jump cuts
- **Images and B-roll** you drop in, pinned to the words they belong to
- **Hook titles**, background music that dips while you talk, loudness set for social apps (-14 LUFS)
- **Undo** for every change, and an instant preview before you render

Everything runs on your computer. Nothing is uploaded.

---

## Setup (Mac, one time)

You need [Homebrew](https://brew.sh). In Terminal:

```sh
brew install ffmpeg whisper-cpp oven-sh/bun/bun

cd path/to/OpenCut/apps/reels
bun install
bun run setup        # downloads the speech model (~550 MB) and checks everything
```

`bun run setup` ends with a checklist. Every line should have a ✓.

> **Model choice.** The default `large-v3-turbo-q5_0` is accurate and fast on Apple
> Silicon (M1 or newer), and handles English, Filipino/Tagalog, Spanish and most
> other languages. On an Intel Mac, use `bun run setup -- --model small.en` (English only).

## Daily use: OpenCut Studio

```sh
cd path/to/OpenCut/apps/reels
bun run studio -- --open        # opens http://localhost:4317
```

1. **Drop** videos, photos and music anywhere on the Studio window. You can also put them in `~/Movies/OpenCut/inbox` with Finder.
2. **Tick** the video(s) on the left and press **New reel**. Transcription starts right away; a 2-minute clip takes well under a minute on an M-series Mac.
3. Press **✨ Auto edit**. This removes silences and um/uh, adds alternating zooms and turns captions on.
4. **Fine-tune** in the panel on the right:
   - **Transcript**: click a word to jump there. Shift-click to select a phrase, then **Cut**, **Restore**, **Make hook** (moves it to the start), **Keep only this**, add a **title**, or pin an **image** to it.
   - **Style**: caption style, words per caption, position, crop vs. fit-with-blur, zooms, music.
   - **Layers**: images and titles, their layout (top half, full screen, card, corner) and timing.
5. Press **Render preview** to check, then **Render final**. Find the MP4 under **Renders → Show in Finder**.

Press **Space** to play or pause. **Undo** steps back through every change, including changes the AI made.

## Let your AI edit: the MCP server

Print the setup snippets for your Mac (with the right paths filled in):

```sh
bun run reels mcp-config
```

It prints ready-to-paste config for:

- **Claude Code**: one command, `claude mcp add --scope user opencut -- …`
- **Claude Desktop**: Settings → Developer → Edit Config, then add the `opencut` entry
- **Codex**: an `[mcp_servers.opencut]` block for `~/.codex/config.toml`
- **Antigravity**: the agent panel's MCP settings → raw config, then add the `opencut` entry

Restart the app after adding it. Then just ask:

> Make a reel from my newest video in OpenCut.

> Cut the 3 best 45-second moments from `podcast-ep4.mp4` into separate reels.

> In the "morning routine" reel, put `coffee.jpg` where I talk about coffee, and make the hook "I wake up at 5am".

> Captions are too big. Use the clean style with 4 words, and remember that I prefer that.

The AI reads your transcript, cuts by word number, looks at your footage and images,
renders a preview, **looks at its own render** to catch problems (a caption over your
face, a badly placed image), fixes them and renders the final. Keep the Studio open
to watch it work. Your client may also offer the built-in prompts **make_reel** and
**clips_from_long_video**.

### Teach it your style

`~/Movies/OpenCut/STYLE.md` holds your editing rules: pacing, hook, captions,
zooms, image placement and length. Every AI reads it before editing. Edit it by hand,
or tell the AI "remember that I like …" and it will update the file.

## Where your files live

```
~/Movies/OpenCut/
  inbox/            drop zone (videos, photos, music)
  brand/fonts/      optional .ttf/.otf fonts for captions
  brand/music/      optional music library
  projects/<reel>/  project.json, history/ (undo), renders/*.mp4
  models/           the speech model
  STYLE.md          your editing rules for the AI
  settings.json     language, model, encoder, silence defaults
```

Set `OPENCUT_WORKSPACE=/some/other/folder` to use another location.

`settings.json` options: `language` (`"auto"`, `"en"`, `"tl"`…), `whisperModel`,
`encoder` (`"auto"`, `"libx264"`, `"h264_videotoolbox"`), `minSilence` (seconds),
`cutPadding` (seconds of air kept at each cut) and `captionStyle`.

## Command line and automation

```sh
bun run reels new "Morning routine" morning.mov --auto --render --final
bun run reels list
bun run reels show morning-routine
bun run reels transcript morning-routine
bun run reels render morning-routine --final
```

`new … --auto --render` runs the whole pipeline without the Studio or an AI, which
suits folder watchers, Shortcuts or scheduled jobs. The AI tools work on these
projects too.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `bun run doctor` shows ✗ for whisper.cpp or FFmpeg | `brew install whisper-cpp ffmpeg` |
| "Whisper model missing" | `bun run setup` |
| The AI app can't find the `opencut` tools | Re-run `bun run reels mcp-config`, use the exact paths it prints (GUI apps don't see your shell PATH), and restart the app |
| iPhone clips look washed out | iPhone "HDR Video" is converted approximately. For exact colors turn off Settings → Camera → Formats → HDR Video, or install an FFmpeg with zimg |
| Captions use the wrong font | Put the font file in `~/Movies/OpenCut/brand/fonts` and set it with the captions `font` option |
| Live preview is black | The browser can't play that video format. Render a preview instead, or use Safari for iPhone HEVC clips |
| Something rendered oddly | Each project folder has `last-render.sh`, the exact FFmpeg command used |

Captions are drawn with libass when your FFmpeg has it, and with a built-in renderer
when it doesn't (Homebrew's FFmpeg currently doesn't), so both work.

## How it works

```
inbox/ ──► analysis (cached per file)          AI client ──MCP──► src/mcp
           ffprobe · whisper.cpp words ·                              │
           silencedetect · thumbnails          Studio (browser) ──► src/studio
                    │                                                 │
                    └──────────► project.json (timeline) ◄────────────┘
                                         │  edits by word id, versioned
                                         ▼
                        src/core/render: one FFmpeg graph
                 cuts · 9:16 crop · zooms · overlays · captions · music · loudness
```

- `src/core`: workspace, analysis, the project schema (zod), edit operations, transcript view, renderer
- `src/mcp`: the MCP server (stdio), 13 tools plus a style-guide resource and two prompts
- `src/studio`: Bun server and React UI, with an instant preview that plays the edit without rendering
- `src/cli.ts`: setup, doctor and headless commands

Development:

```sh
bun test            # unit tests
bun run typecheck
```

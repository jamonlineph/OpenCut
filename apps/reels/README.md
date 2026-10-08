# OpenCut Reels

A fast, local editor for vertical short-form video (Reels, Shorts, TikTok) that an
AI can drive. **Drop a talking-head video and get a finished reel back**: the AI
watches and listens to it, understands what it's about, cuts it, adds captions,
places your photos, and writes the caption and hashtags. You can also edit by hand
in **OpenCut Studio**, or chat with Claude, Codex or Antigravity through the
**MCP server**. All three work on the same projects.

What it does:

- **Transcribes your voice** on your Mac (whisper.cpp), with timing for every word
- **Understands the context**: what you say, frames of the footage, the photos you drop, your `notes.txt`, and your style guide and "about me"
- **Cuts silences, filler words, false starts and retakes** (keeps your last, clean take)
- **Finds the hook** and moves the strongest line to the start, with an on-screen hook title
- **Cuts several shorts** from one long video when it holds several ideas
- **Captions** that highlight each word as you say it (bold, clean or minimal styles)
- **Vertical 9:16 framing** from any video, with punch-in zooms to hide jump cuts
- **Images and B-roll** pinned to the words they belong to
- **Music** that dips while you talk, loudness set for social apps (-14 LUFS)
- **Publish copy**: title, caption and hashtags in your tone
- **Undo** for every change, an instant preview, and "ask the AI" revisions

Your media stays on your computer. The AI sees only what it needs: the transcript,
a few frames and your photos.

---

## Install the Mac app (recommended)

**OpenCut.app** is the easiest way to use all of this. It opens the Studio in its own window and keeps the
autopilot running in the menu bar (✂), even with the window closed. Drop videos
on its Dock icon to auto-edit them. When a reel is ready, you get a notification
that opens it.

**Option A: build it on your Mac (about 2 minutes, no security prompts).** In Terminal:

```sh
brew install ffmpeg whisper-cpp oven-sh/bun/bun   # tools (Homebrew: https://brew.sh)
cd path/to/OpenCut/apps/reels
bun run app                                        # builds, copies to /Applications, opens it
```

**Option B: download it.** Every push builds a disk image on GitHub: open the
repository's **Actions** tab → **OpenCut Reels (macOS app)** → the latest run →
**Artifacts** → `OpenCut-macOS-arm64` (Apple Silicon). Unzip, open `OpenCut.dmg`,
and drag OpenCut to Applications. The build isn't notarized by Apple, so the first
time macOS refuses to open it. Go to **System Settings → Privacy & Security** and
click **Open Anyway**, or run `xattr -dr com.apple.quarantine /Applications/OpenCut.app`.

On first launch the home screen walks you through the rest:

1. **Install tools.** One click opens Terminal with `brew install ffmpeg whisper-cpp`.
2. **Download the speech model** (about 550 MB) with a progress bar.
3. **Connect your AI.** One-click buttons for Claude Code, Claude Desktop and Codex, plus copy-paste config for Antigravity.

Turn on **Start at Login** in the ✂ menu so drops are edited any time. Updating
works the same way: pull the latest code and run `bun run app` again.

## Setup without the app (Terminal)

```sh
brew install ffmpeg whisper-cpp oven-sh/bun/bun

cd path/to/OpenCut/apps/reels
bun install
bun run setup              # downloads the speech model (~550 MB) and checks everything
bun run reels install-agent  # start OpenCut at login, so drops work any time
```

`bun run setup` ends with a checklist. Every line should have a ✓, and the last line
says which AI will edit your drops (see [Which AI edits](#which-ai-edits)).
Don't use `install-agent` and the app's Start at Login together: pick one.

> **Model choice.** The default `large-v3-turbo-q5_0` is accurate and fast on Apple
> Silicon (M1 or newer), and handles English, Filipino/Tagalog, Spanish and most
> other languages. On an Intel Mac, use `bun run setup -- --model small.en` (English only).

## Hands-free: drop a video, get a reel

With OpenCut running (the app, `install-agent`, or `bun start`):

1. **Drop** a video onto the OpenCut Dock icon, into `~/Movies/OpenCut/auto-edit` in Finder, or onto the Studio window with **Auto-edit drops with AI** on.
   - **Add context** in the same drop: photos to show, a music track, and a `notes.txt` saying what the video is about, who it's for and your call to action.
   - **Several clips for one reel?** Put them in a folder and drop the folder. Clips play in name order, and photos and notes inside go with them.
2. OpenCut transcribes the video, the AI decides the edit (and checks its own preview), and the final render is made.
3. You get a **notification**. Each finished reel is in `~/Movies/OpenCut/outbox`: `2026-10-08 My title.mp4`, plus a `.txt` file with the title, caption and hashtags.

Open the reel in the Studio to tweak it, or go to the **AI ✨** tab and ask: *"make the hook punchier"*,
*"cut the part about pricing"*, *"put logo.png at the end"*.

Run it once from Terminal: `bun run reels auto-edit talk.mov photo.jpg notes.txt`.
See what it did: `bun run reels jobs` (retry a failed one with `bun run reels retry JOB`).

### Which AI edits

`settings.json` → `autopilot.director` (default `"auto"` picks the first available):

| Director | Needs | Notes |
| --- | --- | --- |
| `claude-api` | `ANTHROPIC_API_KEY` in `~/Movies/OpenCut/.env` | Fastest and most predictable. Plans the edit, then reviews its own preview frames and fixes problems. Pay-per-use (a few cents per reel). |
| `claude-code` | [Claude Code](https://claude.ai/code) installed and logged in | Uses your Claude subscription. Runs headless with only OpenCut's tools, and renders, looks at and fixes its work like in a chat. |
| `codex` | Codex CLI installed and logged in | Same idea with your ChatGPT plan (experimental). |
| `basic` | nothing | No AI: removes silences, fillers and retakes, adds zooms and captions. |

The `.env` file is for keys, because apps started at login don't see your Terminal settings:

```sh
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> ~/Movies/OpenCut/.env
```

Other `autopilot` settings: `maxReels` (most reels from one video, default 3), `review`
(let the AI check its preview, default on), `notify`, `agentTimeoutMinutes`, and
`webhookUrl`. A webhook receives a JSON summary of every finished reel (title,
caption, hashtags, file path), so you can connect Make, Zapier, n8n or a
Monday.com board.

### Teach it about you

`~/Movies/OpenCut/STYLE.md` starts with an **About me** section (niche, audience,
tone, call to action, handle), followed by your editing rules: pacing, hook,
captions, zooms, images, music, length and publishing. Every AI reads it before
editing. Fill it in once and the AI's choices get much better. You can also tell
the AI "remember that I like …" in chat, and it updates the file.

## Hands-on: OpenCut Studio

```sh
cd path/to/OpenCut/apps/reels
bun start        # opens http://localhost:4317 (already running if you used install-agent)
```

1. Turn **Auto-edit drops with AI** off, then **drop** videos, photos and music on the window to add them to your library (`~/Movies/OpenCut/inbox`).
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

## Where your files live

```
~/Movies/OpenCut/
  auto-edit/        drop here for hands-free editing
  outbox/           finished reels + their caption/hashtags .txt
  inbox/            your library (videos, photos, music)
  brand/fonts/      optional .ttf/.otf fonts for captions
  brand/music/      optional music library
  projects/<reel>/  project.json, history/ (undo), renders/*.mp4
  models/           the speech model
  STYLE.md          about you + your editing rules, read by the AI
  settings.json     language, model, encoder, silence defaults, autopilot
  .env              API keys (optional)
  .autopilot/       job history, logs (studio.log), notes from drops
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

`new … --auto --render` runs the whole pipeline without the Studio or an AI.
`auto-edit FILE…` runs the full AI pipeline once, and `ask PROJECT "…"` revises a reel.
All of these suit Shortcuts or scheduled jobs.

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
| A drop wasn't picked up | OpenCut must be running (`bun start` or `install-agent`). Check the Autopilot panel in the Studio, `bun run reels jobs`, and `~/Movies/OpenCut/.autopilot/studio.log` |
| The AI says "basic" | Install and log in to Claude Code, or add `ANTHROPIC_API_KEY` to `~/Movies/OpenCut/.env`, then restart OpenCut |
| Stop starting at login | `bun run reels uninstall-agent` |

Captions are drawn with libass when your FFmpeg has it, and with a built-in renderer
when it doesn't (Homebrew's FFmpeg currently doesn't), so both work.

## How it works

```
auto-edit/ ──► autopilot: import → analyze → director → final render → outbox/ + notification + webhook
                                              │
             transcript with word ids · frames · your photos · notes.txt · STYLE.md
                                              │
                        Claude API ─ plan (JSON) ─┐   Claude Code / Codex ─ MCP tools ─┐
                                                  ▼                                    ▼
inbox/ ──► analysis (cached per file) ──► project.json (timeline) ◄── Studio (browser) / AI chat (MCP)
           ffprobe · whisper.cpp words ·          │  edits by word id, versioned
           silencedetect · thumbnails             ▼
                         src/core/render: one FFmpeg graph
                 cuts · 9:16 crop · zooms · overlays · captions · music · loudness
```

- `src/core`: workspace, analysis, the project schema (zod), edit operations, retake detection, transcript view, renderer
- `src/core/director`: the AI directors. Context gathering, the plan schema and plan → edit ops, Claude API (structured output + self-review), and headless Claude Code / Codex over MCP
- `src/core/autopilot.ts`: drop-folder watcher, jobs, outbox delivery, notifications and webhook
- `src/mcp`: the MCP server (stdio), 14 tools plus a style-guide resource and two prompts
- `src/studio`: Bun server and React UI, with an instant preview that plays the edit without rendering
- `src/cli.ts`: setup, doctor and headless commands
- `src/main.ts`: entry point of the single-file engine in the Mac app (`opencut-engine studio | mcp | <cli command>`)
- `macos/`: the native app. Swift/AppKit around a WKWebView: menu-bar status, Dock drops, notifications, Start at Login. `build.sh` compiles the engine and app, signs them ad-hoc and makes the DMG

Development:

```sh
bun test            # unit tests
bun run typecheck
```

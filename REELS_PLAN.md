# Plan: an AI-driven Shorts/Reels editor on top of OpenCut

Goal: drop videos and images in a folder, then tell an AI agent (Claude, Codex,
Antigravity, or any MCP client) "make me a reel", and get a finished vertical video
back. The agent should understand what's said (voice, transcript, pacing) and what's
on screen, and drive every edit through an MCP server.

---

## 1. Where this repo actually is today

| Area | State | Implication |
| --- | --- | --- |
| `apps/desktop` (Rust/GPUI) | Empty window with placeholder panels (Preview, Timeline, Inspector, Browser) | No editing engine, timeline model, or playback exists yet |
| `apps/web` | TanStack Start + shadcn UI kit; `/editor` route says "Coming soon" | Good base for a review UI later |
| `apps/api` | Elysia on Cloudflare Workers, health/echo only | Not needed for a local workflow |
| `crates/media` | Pinned FFmpeg 8.1 build, **decode-only**: `--disable-avfilter`, `--disable-programs`, no encoders | Can't cut, caption, or export. You need a full FFmpeg for rendering |
| Upstream roadmap (README) | Editor API, MCP server, headless mode are planned upstream but not built | Upstream may ship these later. Keep our code in new folders so we can still merge upstream |

**Key decision: build agent-first, GUI-second.** For shorts you don't need a full
manual editor. You need:

1. A **project file** (a JSON timeline) that is the single source of truth
2. **Analysis** that turns media into data an LLM can reason about (transcript with word timings, silences, loudness, faces, scenes, frames)
3. A **renderer** that compiles the JSON into an FFmpeg command
4. An **MCP server** that exposes 1–3 as tools

The AI edits the JSON, the renderer produces the MP4, and you review the result. A
GUI is optional polish on top. The GPUI desktop app can wait; it's upstream's
long-term work.

**Language choice:** TypeScript on Bun for the core and the MCP server, plus a small
Python worker for ML analysis.
- The repo already uses Bun, and `zod` is already a dependency (we'll use it for schema validation).
- The official MCP TypeScript SDK is mature, and every major client speaks stdio MCP.
- The best transcription, VAD, and face-tracking tools are Python (faster-whisper/whisperX, Silero VAD, MediaPipe).
- If you later want to move the core into Rust to match upstream, the JSON schema is the contract, so that move is safe.

---

## 2. Architecture

```
            you drop files
                  │
                  ▼
   workspace/inbox/  ──────►  ingest (probe, normalize to CFR proxy, thumbnails)
                                   │
                                   ▼
                              analyze (Python worker) ──► analysis/*.json
                                   │   transcript+words, silences, loudness,
                                   │   scenes, faces, speaker turns
                                   ▼
   Claude / Codex / Antigravity ◄──MCP──►  apps/mcp  ──► project.json (timeline)
        (decides the edit)                     │
                                               ▼
                                       render compiler ──► FFmpeg ──► renders/v003.mp4
                                               │
                                               ▼
                                 frames of the render ──► agent checks its own work
```

### Proposed folders (all new, so merges with upstream stay clean)

```
apps/mcp/                  MCP server (Bun + @modelcontextprotocol/sdk, stdio)
packages/reels-core/       schema (zod), timeline ops, FFmpeg/ASS compiler, presets
workers/analyze/           Python (uv): transcribe, VAD, faces, scenes, audio features
REELS_PLAN.md         this file
workspace/                 (gitignored) your actual media
  inbox/                   ← drop zone
  brand/                   brand.json, fonts/, logo.png, music/
  projects/<slug>/
    project.json           the timeline (the agent edits this)
    history/               every saved version → undo/revert
    media/                 originals (or links) + proxies/
    analysis/              <asset>.transcript.json, .silences.json, .faces.json, ...
    renders/               v001.mp4, v002.mp4, preview_*.mp4
    publish.json           title, description, hashtags per platform
```

### The project file (shorts-shaped, deliberately simple)

```jsonc
{
  "version": 1,
  "canvas": { "width": 1080, "height": 1920, "fps": 30 },
  "clips": [                                  // main track, played in order
    { "id": "c1", "asset": "talk.mp4",
      "fromWord": 12, "toWord": 58,           // cut by word IDs, not raw seconds
      "reframe": { "mode": "face" },          // face | center | manual {x}
      "zooms": [{ "atWord": 30, "scale": 1.15, "ease": "punch" }] }
  ],
  "overlays": [
    { "type": "image", "asset": "photo1.jpg", "fromWord": 20, "toWord": 26, "layout": "full" },
    { "type": "text", "text": "3 mistakes I made", "start": 0, "end": 2.0, "style": "hook" }
  ],
  "captions": { "style": "bold-pop", "maxWords": 3, "highlightActiveWord": true },
  "audio": { "music": { "asset": "lofi.mp3", "gainDb": -20, "duck": true }, "targetLufs": -14 },
  "export": { "preset": "reels-1080p30" }
}
```

Why word IDs: LLMs are bad at timestamp arithmetic. The agent says "keep words
12–58", and the server snaps that to exact times, adds breathing padding, and avoids
cutting mid-syllable. Seconds stay available for things that aren't tied to speech.

---

## 3. MCP tool surface (keep it small)

About 15 well-described tools work better than 50. Deterministic math (silence
cutting, snapping, frame math) runs on the server, not in the LLM.

**Workspace**
- `list_inbox()`: new files with duration, resolution, and whether they have audio
- `create_project(name, files[], preset)`: ingests, analyzes, and returns a project summary
- `list_projects()`, `get_project(id)`

**Understanding (voice + visuals)**
- `get_transcript(project, asset, range?, detail="segments"|"words")`: compact `[12.4s #12] text…` format. Paged for long videos to save tokens
- `get_audio_insights(asset)`: silences, loudness, speaking rate, energy/pitch peaks (emphasis), filler words, speaker turns
- `get_frames(asset, times[] | everyNSeconds)`: returns images so the model can *see* the footage (framing, B-roll moments, faces)
- `find_moments(asset, kind="hooks"|"highlights"|"quotes")`: ranked candidate segments from heuristics (energy, punchlines, questions). The agent makes the final call

**Editing**
- `apply_edits(project, ops[])`: ops are `keep_range`, `cut_range`, `remove_silences{minGap,padding}`, `remove_fillers`, `add_overlay`, `add_text`, `add_zoom`, `set_captions`, `set_music`, `reframe`, `reorder`. Validated, versioned, and returns a diff summary
- `set_timeline(project, json)`: full replace (power move, validated by zod)
- `revert(project, version)`

**Output**
- `render(project, quality="preview"|"final")`: preview is 540p/ultrafast for quick checks
- `inspect_render(project, version, times[])`: frames of the actual output so the agent can verify that captions don't cover the face, that captions sit in safe zones, and that nothing is black
- `save_publish_copy(project, {title, description, hashtags, platform})`

**Resources and prompts**
- Resources: `brand://kit`, `styles://captions`, `guide://style` (your editing rules in one markdown file, shared by every agent)
- Prompts (one-click recipes): `talking-head-reel`, `long-video-to-clips`, `photo-slideshow-reel`, `podcast-clip`

### Example session

> **You:** Make a 45s reel from today's inbox video, hook first, my usual style.
>
> **Agent:** `list_inbox` → `create_project` → `get_transcript` → `get_audio_insights` →
> picks the strongest 45s and moves the punchline to the front as the hook →
> `apply_edits([keep_range…, remove_silences, remove_fillers, set_captions, add_zoom…])` →
> `render(preview)` → `inspect_render` → fixes a caption overlapping the chin →
> `render(final)` → `save_publish_copy` → "Done: renders/v002.mp4, 44.8s. Title options: …"

---

## 4. Voice and audio analysis (what "reads the voice" means concretely)

| Signal | Tool | Used for |
| --- | --- | --- |
| Transcript + **word timestamps** | faster-whisper / whisperX (local, free, GPU helps) **or** Deepgram / AssemblyAI (API, fast, cheap) | Everything: cuts, captions, finding moments |
| Filler words (um, uh, like) | Deepgram `filler_words`, or CrisperWhisper | Filler removal. **Gotcha:** standard Whisper usually *drops* fillers from the text, so it can't remove what it didn't transcribe |
| Silences / pauses | Silero VAD (more robust), ffmpeg `silencedetect` (quick) | Jump-cut pacing |
| Loudness | ffmpeg `ebur128` / two-pass `loudnorm` | Normalize to about -14 LUFS for social |
| Energy, pitch, speaking rate | librosa (RMS, pYIN), words/sec from the transcript | Emphasis → zoom punch-ins, finding hooks |
| Speakers | pyannote or the API's diarization | Podcasts/interviews: who's talking → reframe to them |
| Scene cuts | PySceneDetect | B-roll alignment, multi-clip footage |
| Faces | MediaPipe face detection at ~5 fps, smoothed | 16:9 → 9:16 auto-reframe |

If you record in more than one language or mix languages, test transcription accuracy
on your own footage in Phase 1 before you commit to a provider.

---

## 5. Rendering (FFmpeg compile step)

- Compile `project.json` into one FFmpeg command: `trim`/`atrim` per clip → `concat` → `crop`/`scale` to 1080×1920 (crop path from face data) → `overlay` images → `zoompan`/scale keyframes for punch-ins → `ass` filter for captions → audio: `concat` + music with `sidechaincompress` ducking + `loudnorm`.
- **Captions via ASS subtitles (libass):** word-by-word highlight, pop/scale animations (`\t`), outlines, and custom fonts. This covers most "viral caption" styles without a browser renderer. Remotion is an option later for very fancy motion graphics, but check its license first.
- Output: H.264 (libx264, CRF ~18–20), yuv420p, AAC 192k, CFR 30 or 60 fps, `-movflags +faststart`.
- **You need a full FFmpeg** with libx264, libass, and avfilter (Homebrew `ffmpeg`, the gyan.dev "full" build on Windows, or distro packages). The repo's pinned LGPL decode-only build won't do it. x264 is GPL, which is fine for personal use; check the license before you ever redistribute.
- **Ingest normalization prevents most weird bugs.** Phone footage is often variable frame rate (causes audio drift), HDR/HLG (looks washed out), and rotated by metadata. Transcode a CFR SDR proxy at ingest and edit against that.
- Safe zones: platform UI covers the bottom and right edge on Reels, TikTok, and Shorts. Keep captions and text in a configurable safe box (roughly the middle 60–70% of the height), and have `inspect_render` check it.

---

## 6. Build phases

Each phase ends with something you can use. Each one is sized so you can hand it to an
AI coding agent as a single task.

### Phase 0: setup and decisions
- Install full FFmpeg, Python 3.11+ with `uv`, and Bun (pinned in `.prototools`).
- Decide on local vs. API transcription (see open questions).
- Add `workspace/` to `.gitignore` and create `brand/brand.json` (fonts, colors, logo, default music).
- Write `guide://style`, your editing rules in plain English: pacing, caption style, hook rules, length targets, CTA. This is what makes the output feel like *you*.

**Done when:** `ffmpeg -filters | grep -E "ass|loudnorm"` shows both filters, and the style guide exists.

### Phase 1: ingest and analysis CLI
- `workers/analyze`: `analyze <file> --out analysis/` writes transcript (with word IDs), silences, loudness, scenes, and faces as JSON.
- `packages/reels-core`: `ingest` (ffprobe, CFR/SDR proxy, thumbnails).
- Test on 3 of your real videos: a talking head, a long podcast, and a phone clip.

**Done when:** a 2-minute talking head gives an accurate transcript with word timings, and you've checked filler detection on your own voice.

### Phase 2: timeline schema and renderer
- zod schema for `project.json`, timeline ops (`remove_silences`, `keep_range`, …), and word→time snapping.
- FFmpeg compiler and ASS caption generator with 2–3 caption styles.
- Golden tests: a fixed `project.json` must produce the same output duration and frame checks.

**Done when:** a hand-written `project.json` renders a correct 9:16 MP4 with jump cuts, word-highlight captions, and normalized audio.

### Phase 3: MCP server
- `apps/mcp` over stdio with the tools from §3, starting with the minimum set: `list_inbox`, `create_project`, `get_transcript`, `get_frames`, `apply_edits`, `render`, `inspect_render`.
- Connect your clients:
  - **Claude Code:** `claude mcp add reels -- bun run /path/to/OpenCut/apps/mcp/src/index.ts`
  - **Codex:** `~/.codex/config.toml` → `[mcp_servers.reels]` with `command = "bun"`, `args = ["run", ".../apps/mcp/src/index.ts"]`
  - **Antigravity:** MCP settings → edit the raw `mcp_config.json` → add `"reels": { "command": "bun", "args": [...] }`
  - Image results from `get_frames` work in Claude. If a client can't display images, the tool also returns the saved file paths.

**Done when:** you say "make a reel from the newest inbox video" in chat and get a correct MP4 end to end.

### Phase 4: shorts intelligence
- Silence and filler removal with tunable aggressiveness ("tight" / "natural").
- Hook finder: move the strongest line to second 0, and add an on-screen hook text.
- Long-form → N clips: `find_moments` returns ranked candidates, and the agent renders multiple projects in one go.
- Auto-reframe: v1 is a static crop on the median face per clip; v2 is a smoothed dynamic crop that follows the speaker.
- Zoom punch-ins on emphasis words (energy and pitch peaks).
- B-roll: match inbox images and clips to transcript topics (the agent uses `get_frames` to look at them), with Ken Burns motion on stills.
- Music: choose from `brand/music`, duck under voice, and optionally cut on beats (librosa beat tracking) for photo-only reels.
- `publish.json`: title, description, and hashtags per platform.

### Phase 5: style presets and recipes
- Caption style library, intro/outro, logo watermark, color/LUT preset.
- MCP prompts for your recurring formats. Saved prompts are how you get consistent results across Claude, Codex, and Antigravity.

### Phase 6: review UI (optional, in `apps/web` `/editor`)
- A drag-and-drop zone that uploads to `inbox/`, a player for the latest render, and the transcript with removed words struck through. Click a word to restore it, and use "approve" or "regenerate with note".
- This reuses the existing shadcn components. Not required to ship reels.

### Phase 7: automation (fits your automation background)
- **Folder watcher:** new file in `inbox/` → run the pipeline headlessly (`claude -p "<recipe>"` or the Claude Agent SDK) → draft render ready → notification.
- **Content pipeline board** (e.g. Monday.com): items go through Dropped → Draft rendered → Approved → Scheduled → Posted. The render link and publish copy are attached to each item.
- **Posting (later):** YouTube Data API (Shorts), Instagram Graph API (Reels; needs a Business/Creator account), TikTok Content Posting API (needs app review). Keep a human "approve" step before anything gets posted.

---

## 7. Risks and gotchas to plan for

- **Fork drift:** upstream is mid-rewrite. Put all our code in `apps/mcp`, `packages/reels-core`, and `workers/analyze`, and don't edit their files, so `git merge upstream/main` stays painless. If upstream ships its own MCP server or headless mode, evaluate switching to it.
- **Token cost:** never dump full word-level JSON into the chat. Segment text first, words on request, paged.
- **LLM timestamp errors:** cut by word IDs and let the server snap times (§2).
- **Whisper hides fillers:** see §4.
- **VFR / HDR / rotated phone footage:** normalize at ingest (§5).
- **Caption fonts:** bundle fonts in `brand/fonts` and point libass at that folder, or captions fall back to a default font.
- **Platform limits change** (max length, specs): keep them in one `presets.ts` file you can update.

---

## 8. Open questions (defaults in bold)

1. Transcription: **local faster-whisper/whisperX** (free, private, slower without a GPU) or an API like Deepgram (fast, detects fillers, costs a few cents per minute)?
2. Your main machine: Windows, macOS, or Linux? Does it have an NVIDIA GPU? This affects install steps and speed.
3. Main source footage: **talking head to camera**, podcasts/interviews (multi-speaker), or screen recordings?
4. Mostly reels from short clips, or cutting long videos into many shorts?
5. Caption style reference: a creator whose look you want to match?

## 9. Suggested first task for your coding agent

> "Implement Phase 1 of REELS_PLAN.md: create `workers/analyze` (uv, faster-whisper with
> word timestamps, Silero VAD, ffmpeg ebur128) and `packages/reels-core/ingest.ts`
> (ffprobe + CFR SDR proxy). Output JSON files as described. Add a README with setup steps."

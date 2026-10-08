// Written to <workspace>/STYLE.md on first run. The MCP server hands it to every
// agent, so editing this file changes how Claude, Codex and Antigravity cut.
export const DEFAULT_STYLE_GUIDE = `# My Reels Style Guide

Edit this file to change how the AI edits your videos. Every agent reads it
before editing.

## Format
- Vertical 1080x1920, 30 fps.
- Target length: 30-60 seconds unless I ask otherwise. Never longer than 90 seconds.

## Pacing
- Remove silences and filler words (um, uh) in every reel.
- Cut false starts, repeated sentences and retakes. When I say a sentence twice,
  keep the last, cleanest take.
- Keep it tight but natural: do not cut in the middle of a word.

## Hook
- The first 2 seconds must grab attention. If the strongest line is later in the
  video, move it to the start.
- Add a short hook title (max 6 words) on screen for the first 2-3 seconds.

## Captions
- Captions always on, style "bold", max 3 words at a time, active word highlighted.

## Zoom
- Alternate a subtle punch-in (1.12x) between cuts to hide jump cuts.

## Images and B-roll
- When I drop images with a video, place each one where the transcript talks about
  it (look at the images first). Show each for 2-4 seconds.
- Use layout "top" for photos and screenshots so my face stays visible, unless the
  image needs the full screen.

## Ending
- End on a clear final line or call to action. Do not end mid-thought.
`;

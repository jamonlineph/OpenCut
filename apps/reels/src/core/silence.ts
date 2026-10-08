import { ffmpegBin, run } from "./exec";
import { round3, type Interval } from "./intervals";

export type SilenceAnalysis = {
  /** dB level below which audio counts as silence. */
  thresholdDb: number;
  meanVolumeDb: number;
  maxVolumeDb: number;
  /** Every pause of 0.2s or longer. Edits filter by their own minimum. */
  silences: Interval[];
};

/**
 * Picks a silence threshold from the clip's own loudness, so a quiet room mic
 * and a loud lav both cut well without tuning.
 */
export async function detectSilences(wav: string, duration: number): Promise<SilenceAnalysis> {
  const vol = await run([ffmpegBin(), "-hide_banner", "-nostats", "-i", wav, "-af", "volumedetect", "-f", "null", "-"]);
  const mean = Number(vol.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1] ?? -30);
  const max = Number(vol.stderr.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1] ?? 0);
  const thresholdDb = Math.round(Math.min(-28, Math.max(-55, mean - 14)));

  const det = await run([
    ffmpegBin(),
    "-hide_banner",
    "-nostats",
    "-i",
    wav,
    "-af",
    `silencedetect=noise=${thresholdDb}dB:d=0.2`,
    "-f",
    "null",
    "-",
  ]);
  const silences: Interval[] = [];
  let open: number | null = null;
  for (const line of det.stderr.split("\n")) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) open = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (e && open !== null) {
      silences.push({ start: round3(open), end: round3(Number(e[1])) });
      open = null;
    }
  }
  if (open !== null && duration > open) silences.push({ start: round3(open), end: round3(duration) });
  return { thresholdDb, meanVolumeDb: mean, maxVolumeDb: max, silences };
}

import { ffprobeBin, runOrThrow } from "./exec";
import type { MediaKind } from "./workspace";

export type MediaInfo = {
  kind: MediaKind;
  duration: number;
  /** Display size, after applying rotation metadata. */
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  rotation: number;
  /** HLG / PQ footage (iPhone "HDR Video") that needs tone mapping. */
  hdr: boolean;
  videoCodec?: string;
};

type ProbeStream = {
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  color_transfer?: string;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
};

function parseRate(rate?: string): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return 0;
  return num / den;
}

export async function probe(file: string, kind: MediaKind): Promise<MediaInfo> {
  const { stdout } = await runOrThrow([
    ffprobeBin(),
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  const data = JSON.parse(stdout) as { streams: ProbeStream[]; format: { duration?: string } };
  const video = data.streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = data.streams.find((s) => s.codec_type === "audio");

  const rotation = Math.round(
    Number(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0),
  );
  const sideways = Math.abs(rotation) % 180 === 90;
  const rawW = video?.width ?? 0;
  const rawH = video?.height ?? 0;
  const transfer = video?.color_transfer ?? "";

  return {
    kind,
    duration: Number(data.format.duration ?? video?.duration ?? 0) || 0,
    width: sideways ? rawH : rawW,
    height: sideways ? rawW : rawH,
    fps: Math.round((parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate)) * 1000) / 1000,
    hasAudio: Boolean(audio),
    rotation,
    hdr: kind === "video" && (transfer === "arib-std-b67" || transfer === "smpte2084"),
    videoCodec: video?.codec_name,
  };
}

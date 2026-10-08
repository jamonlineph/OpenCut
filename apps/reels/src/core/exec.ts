import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

// GUI apps on macOS (Claude Desktop, Antigravity) launch MCP servers with a
// minimal PATH that leaves out Homebrew, so look in the usual places too.
const HOME = process.env.HOME ?? "";
const EXTRA_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  join(HOME, ".bun/bin"),
  join(HOME, ".local/bin"), // Claude Code's native installer
  join(HOME, ".claude/local"),
  join(HOME, ".npm-global/bin"),
];

const found = new Map<string, string | null>();

export function which(name: string, envOverride?: string): string | null {
  if (envOverride && process.env[envOverride]) return process.env[envOverride]!;
  if (found.has(name)) return found.get(name)!;
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...EXTRA_BIN_DIRS].filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      found.set(name, candidate);
      return candidate;
    }
  }
  found.set(name, null);
  return null;
}

export function requireBin(name: string, envOverride: string, hint: string): string {
  const bin = which(name, envOverride);
  if (!bin) throw new Error(`${name} not found. ${hint}`);
  return bin;
}

export const ffmpegBin = () => requireBin("ffmpeg", "OPENCUT_FFMPEG", "Install it with: brew install ffmpeg");
export const ffprobeBin = () => requireBin("ffprobe", "OPENCUT_FFPROBE", "Install it with: brew install ffmpeg");

export type RunResult = { code: number; stdout: string; stderr: string };

export type RunOptions = {
  cwd?: string;
  /** Called with each chunk of stdout, for progress parsing. */
  onStdout?: (chunk: string) => void;
  /** Called with each chunk of stderr, for progress parsing. */
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
};

export async function run(cmd: string[], options: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
  });
  const read = async (stream: ReadableStream<Uint8Array>, onChunk?: (chunk: string) => void) => {
    const decoder = new TextDecoder();
    let text = "";
    for await (const bytes of stream) {
      const chunk = decoder.decode(bytes, { stream: true });
      text += chunk;
      // Keep memory bounded for chatty tools like ffmpeg.
      if (text.length > 4_000_000) text = text.slice(-2_000_000);
      onChunk?.(chunk);
    }
    return text;
  };
  const [stdout, stderr, code] = await Promise.all([
    read(proc.stdout, options.onStdout),
    read(proc.stderr, options.onStderr),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function runOrThrow(cmd: string[], options: RunOptions = {}): Promise<RunResult> {
  const result = await run(cmd, options);
  if (result.code !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-15).join("\n");
    throw new Error(`${cmd[0]!.split("/").pop()} failed (exit ${result.code}):\n${tail}`);
  }
  return result;
}

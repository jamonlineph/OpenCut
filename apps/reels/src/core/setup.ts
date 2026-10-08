import { createWriteStream, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { readSettings, writeSettings, type Workspace } from "./workspace";

export const MODELS = {
  "large-v3-turbo-q5_0": { file: "ggml-large-v3-turbo-q5_0.bin", size: "547 MB", note: "best accuracy, fast on Apple Silicon (default)" },
  "large-v3-turbo": { file: "ggml-large-v3-turbo.bin", size: "1.6 GB", note: "same, unquantized" },
  "small.en": { file: "ggml-small.en.bin", size: "466 MB", note: "English only, good on Intel Macs" },
  "base.en": { file: "ggml-base.en.bin", size: "142 MB", note: "English only, fastest, less accurate" },
  small: { file: "ggml-small.bin", size: "466 MB", note: "multilingual" },
} as const;

export type ModelName = keyof typeof MODELS;

const BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export async function downloadModel(
  ws: Workspace,
  name: ModelName,
  log: (msg: string) => void = console.log,
  onProgress?: (fraction: number) => void,
) {
  const model = MODELS[name];
  const dest = join(ws.models, model.file);
  if (existsSync(dest)) {
    log(`Model already downloaded: ${dest}`);
  } else {
    log(`Downloading ${model.file} (${model.size})…`);
    const response = await fetch(`${BASE_URL}/${model.file}`);
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length") ?? 0);
    const tmp = `${dest}.part`;
    const out = createWriteStream(tmp);
    let received = 0;
    let lastPct = -1;
    try {
      for await (const chunk of response.body) {
        out.write(chunk);
        received += chunk.length;
        if (total) onProgress?.(received / total);
        const pct = total ? Math.floor((received / total) * 100) : -1;
        if (pct !== lastPct && pct % 5 === 0) {
          log(`  ${pct}%`);
          lastPct = pct;
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      renameSync(tmp, dest);
    } catch (error) {
      out.destroy();
      rmSync(tmp, { force: true });
      throw error;
    }
    log(`Saved ${dest}`);
  }
  if (readSettings(ws).whisperModel !== model.file) writeSettings(ws, { whisperModel: model.file });
}

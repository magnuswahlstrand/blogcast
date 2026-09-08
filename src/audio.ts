import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHUNK_CACHE_DIR } from "./config.ts";
import type { Chunk } from "./chunk.ts";
import type { Tts } from "./tts/index.ts";

export function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

/**
 * Synthesize every chunk, reusing any cached MP3 whose text hash and voice
 * match. Changing one paragraph re-renders one chunk, not the whole episode.
 */
export async function synthesizeChunks(
  chunks: Chunk[],
  tts: Tts,
  options: { force?: boolean; concurrency?: number } = {},
): Promise<{ files: string[]; rendered: number; cached: number }> {
  await mkdir(CHUNK_CACHE_DIR, { recursive: true });
  const voiceKey = tts.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const files = chunks.map((chunk) =>
    path.join(CHUNK_CACHE_DIR, `${voiceKey}-${chunk.hash}.mp3`),
  );

  let rendered = 0;
  let cached = 0;
  const queue = chunks.map((chunk, index) => ({ chunk, file: files[index] }));
  const workers = Array.from(
    { length: Math.max(1, options.concurrency ?? 3) },
    async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        if (!options.force && (await exists(job.file))) {
          cached++;
          continue;
        }
        // Write to a sibling first so an interrupted run never leaves a
        // truncated MP3 that the next run would treat as cached.
        const partial = `${job.file}.partial`;
        await writeFile(partial, await tts.synthesize(job.chunk.text));
        await rename(partial, job.file);
        rendered++;
        process.stderr.write(
          `  chunk ${job.chunk.index + 1}/${chunks.length} rendered\n`,
        );
      }
    },
  );
  await Promise.all(workers);

  return { files, rendered, cached };
}

export async function concatMp3(
  files: string[],
  output: string,
  tags: { title: string; artist?: string | null; album?: string },
): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  const dir = await mkdtemp(path.join(tmpdir(), "blogcast-concat-"));
  const listFile = path.join(dir, "list.txt");
  try {
    await writeFile(
      listFile,
      files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n"),
      "utf8",
    );
    const metadata = [
      "-metadata", `title=${tags.title}`,
      "-metadata", `artist=${tags.artist ?? "Blogcast"}`,
      "-metadata", `album=${tags.album ?? "Blogcast"}`,
    ];
    await run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", listFile,
      "-codec:a", "libmp3lame", "-qscale:a", "4", "-ar", "44100", "-ac", "1",
      ...metadata,
      output,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function probe(
  file: string,
): Promise<{ bytes: number; seconds: number; duration: string }> {
  const { size } = await stat(file);
  const raw = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const seconds = Math.round(Number(raw.trim()) || 0);
  return { bytes: size, seconds, duration: formatDuration(seconds) };
}

export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Tts } from "./index.ts";
import { run } from "../audio.ts";

/**
 * macOS `say`, piped through ffmpeg. No API key, no network, no cost - the
 * point is that the whole pipeline is runnable end to end before you enable a
 * paid provider.
 */
export function sayTts(voice: string): Tts {
  const selected = voice || "Samantha";
  return {
    id: `say:${selected}`,
    async synthesize(text) {
      const dir = await mkdtemp(path.join(tmpdir(), "blogcast-say-"));
      const textFile = path.join(dir, "chunk.txt");
      const aiff = path.join(dir, "chunk.aiff");
      const mp3 = path.join(dir, "chunk.mp3");
      try {
        await writeFile(textFile, text, "utf8");
        await run("say", ["-v", selected, "-f", textFile, "-o", aiff]);
        await run("ffmpeg", [
          "-y", "-loglevel", "error",
          "-i", aiff,
          "-codec:a", "libmp3lame", "-qscale:a", "4", "-ar", "44100", "-ac", "1",
          mp3,
        ]);
        return await readFile(mp3);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

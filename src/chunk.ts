import { CHUNK_TARGET_CHARS } from "./config.ts";
import { sha256 } from "./markdown.ts";

export type Chunk = { index: number; text: string; hash: string };

/**
 * Split speech text into TTS-sized pieces on semantic boundaries: a heading
 * always starts a new chunk, otherwise we break between paragraphs, and only
 * fall back to sentence boundaries when a single paragraph is oversized.
 *
 * Each chunk is keyed by the hash of its own normalized text, so editing one
 * paragraph only invalidates the chunk it lives in.
 */
export function chunkSpeech(speech: string, target = CHUNK_TARGET_CHARS): Chunk[] {
  const blocks = speech
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap((block) => (block.length > target ? splitSentences(block, target) : [block]));

  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    const startsSection = /^#{1,6}\s/.test(block);
    const wouldOverflow = current && current.length + block.length + 2 > target;
    if (current && (startsSection || wouldOverflow)) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) chunks.push(current);

  return chunks.map((text, index) => ({
    index,
    text,
    hash: sha256(normalize(text)),
  }));
}

function splitSentences(block: string, target: number): string[] {
  const sentences = block.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [block];
  const out: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > target) {
      out.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Whitespace-insensitive, so reflowing text does not bust the audio cache. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

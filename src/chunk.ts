import { CHUNK_TARGET_CHARS } from "./config.ts";
import { sha256 } from "./markdown.ts";
export type Chunk = { index: number; text: string; hash: string };
const MAX_SENTENCE_CHARS = 400;
/** * Split speech text into TTS-sized pieces on semantic boundaries: * - headings always start a new chunk * - paragraphs are preserved where possible * - all text is checked for oversized sentences * - oversized sentences are split on punctuation/whitespace */ export function chunkSpeech(
  speech: string,
  target = CHUNK_TARGET_CHARS,
): Chunk[] {
  const blocks = speech
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap((block) => splitBlock(block, target));
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    const startsSection = /^#{1,6}\s/.test(block);
    const wouldOverflow =
      current.length > 0 && current.length + block.length + 2 > target;
    if (current && (startsSection || wouldOverflow)) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks.map((text, index) => ({
    index,
    text,
    hash: sha256(normalize(text)),
  }));
}
function splitBlock(block: string, target: number): string[] {
  const prepared = prepareForSegmentation(block);
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const sentences = [...segmenter.segment(prepared)]
    .map(({ segment }) => segment.trim())
    .filter(Boolean)
    .flatMap((sentence) =>
      splitOversizedSentence(sentence, MAX_SENTENCE_CHARS),
    );
  const out: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const wouldOverflow =
      current.length > 0 && current.length + sentence.length + 1 > target;
    if (wouldOverflow) {
      out.push(current.trim());
      current = "";
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current.trim()) {
    out.push(current.trim());
  }
  return out;
}
/** * Lists often lack punctuation, which can make TTS engines treat several * items as one sentence. */ function prepareForSegmentation(
  text: string,
): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return "";
      }
      const isBullet = /^[-*+]\s+/.test(trimmed);
      const isNumberedItem = /^\d+[.)]\s+/.test(trimmed);
      const isHeading = /^#{1,6}\s+/.test(trimmed);
      if (
        (isBullet || isNumberedItem || isHeading) &&
        !hasSentenceEnding(trimmed)
      ) {
        return `${trimmed}.`;
      }
      return line;
    })
    .join("\n");
}
function splitOversizedSentence(text: string, max: number): string[] {
  if (text.length <= max) {
    return [text];
  }
  const out: string[] = [];
  let remaining = text.trim();
  while (remaining.length > max) {
    const search = remaining.slice(0, max + 1);
    const candidates = [
      search.lastIndexOf("\n"),
      search.lastIndexOf(". "),
      search.lastIndexOf("? "),
      search.lastIndexOf("! "),
      search.lastIndexOf("; "),
      search.lastIndexOf(": "),
      search.lastIndexOf(" — "),
      search.lastIndexOf(", "),
      search.lastIndexOf(" "),
    ];
    let cut = Math.max(...candidates);
    if (cut < max * 0.5) {
      cut = max;
    }
    let part = remaining.slice(0, cut).trim();
    if (!hasSentenceEnding(part)) {
      part += ".";
    }
    out.push(part);
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) {
    out.push(remaining);
  }
  return out;
}
function hasSentenceEnding(text: string): boolean {
  return /[.!?]["')\]]?$/.test(text);
}
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

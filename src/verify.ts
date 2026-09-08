import { readFile } from "node:fs/promises";
import path from "node:path";
import { articleDir } from "./store.ts";

export type Finding = { level: "warn" | "error"; message: string };

/**
 * The failure mode that matters here is not extraction - it is a model quietly
 * deciding a paragraph "doesn't need to be read". Because article.md is the
 * archival copy, we can always check speech.md against it.
 */
export async function verifyArticle(slug: string): Promise<Finding[]> {
  const dir = articleDir(slug);
  const [articleMd, speechMd] = await Promise.all([
    readFile(path.join(dir, "article.md"), "utf8"),
    readFile(path.join(dir, "speech.md"), "utf8"),
  ]);

  const findings: Finding[] = [];
  const article = stripFrontmatter(articleMd);
  const speechWords = wordSet(speechMd);

  const missingHeadings = headings(article).filter(
    (heading) => !containsPhrase(speechMd, heading),
  );
  if (missingHeadings.length) {
    findings.push({
      level: "warn",
      message: `${missingHeadings.length} heading(s) missing from speech: ${missingHeadings
        .slice(0, 5)
        .map((h) => JSON.stringify(h))
        .join(", ")}`,
    });
  }

  const articleProse = proseWords(article);
  const ratio = articleProse.length
    ? countWords(speechMd) / articleProse.length
    : 1;
  if (ratio < 0.75) {
    findings.push({
      level: "error",
      message: `speech.md has ${(ratio * 100).toFixed(0)}% of the prose word count - the model likely dropped content`,
    });
  } else if (ratio > 1.6) {
    findings.push({
      level: "warn",
      message: `speech.md is ${(ratio * 100).toFixed(0)}% of the prose word count - the model may have added narration`,
    });
  }

  const dropped = distinctiveWords(articleProse).filter(
    (word) => !speechWords.has(word),
  );
  if (dropped.length > 3) {
    findings.push({
      level: "warn",
      message: `${dropped.length} distinctive term(s) absent from speech: ${dropped.slice(0, 8).join(", ")}`,
    });
  }

  if (/\{\{(CODE|TABLE):/.test(speechMd)) {
    findings.push({
      level: "error",
      message: "speech.md still contains unresolved {{CODE}}/{{TABLE}} placeholders",
    });
  }
  if (/https?:\/\//.test(speechMd)) {
    findings.push({ level: "warn", message: "speech.md still contains a raw URL" });
  }
  if (/\]\(/.test(speechMd)) {
    findings.push({
      level: "warn",
      message: "speech.md still contains Markdown link syntax",
    });
  }

  return findings;
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
}

function headings(markdown: string): string[] {
  return [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)]
    .map((match) =>
      match[1]
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // heading permalinks
        .replace(/[*_`]/g, "")
        .trim(),
    )
    .filter((heading) => heading.length > 2);
}

function containsPhrase(haystack: string, phrase: string): boolean {
  return normalize(haystack).includes(normalize(phrase));
}

/** Prose only: fenced code and tables are expected to be rewritten or dropped. */
function proseWords(markdown: string): string[] {
  const prose = markdown
    .replace(/^```[\s\S]*?^```$/gm, " ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/\]\([^)]*\)/g, "] ") // link targets are never spoken
    .replace(/https?:\/\/\S+/g, " ");
  return tokenize(prose);
}

const countWords = (text: string) => tokenize(text).length;

function tokenize(text: string): string[] {
  return normalize(text).split(" ").filter(Boolean);
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function wordSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/**
 * Rare-ish words are the cheapest proxy for "was this paragraph read?" - a
 * summary keeps the common words and loses the specific ones.
 */
function distinctiveWords(words: string[]): string[] {
  const counts = new Map<string, number>();
  for (const word of words) {
    if (word.length < 8) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count === 1)
    .map(([word]) => word);
}

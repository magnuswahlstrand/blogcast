import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARTICLES_DIR } from "./config.ts";
import { frontmatter, sha256 } from "./markdown.ts";

export type ArticleMeta = {
  /** Idempotency key: derived from the canonical URL and nothing else. */
  id: string;
  slug: string;
  source: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  addedAt: string;
  excerpt: string | null;
  siteName: string | null;
  speechHash: string;
  speechUsedModel: boolean;
  voice: string;
  audio: string; // site-relative, e.g. /audio/2026-09-02-slug.mp3
  audioBytes: number;
  durationSeconds: number;
};

export const articleId = (canonicalUrl: string) =>
  `sha256:${sha256(canonicalUrl)}`;

export const articleDir = (slug: string) => path.join(ARTICLES_DIR, slug);

export async function saveArticle(
  slug: string,
  files: { articleMd: string; speechMd: string; meta: ArticleMeta },
): Promise<void> {
  const dir = articleDir(slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "article.md"), files.articleMd, "utf8");
  await writeFile(path.join(dir, "speech.md"), files.speechMd, "utf8");
  await writeFile(
    path.join(dir, "metadata.json"),
    `${JSON.stringify(files.meta, null, 2)}\n`,
    "utf8",
  );
}

export function renderArticleMd(
  meta: Pick<ArticleMeta, "title" | "author" | "publishedAt" | "source">,
  body: string,
): string {
  return `${frontmatter({
    title: meta.title,
    author: meta.author,
    published: meta.publishedAt,
    source: meta.source,
  })}\n# ${meta.title}\n\n${body.trim()}\n`;
}

export async function loadMeta(slug: string): Promise<ArticleMeta | null> {
  try {
    const raw = await readFile(
      path.join(articleDir(slug), "metadata.json"),
      "utf8",
    );
    return JSON.parse(raw) as ArticleMeta;
  } catch {
    return null;
  }
}

export async function readSpeech(slug: string): Promise<string> {
  return readFile(path.join(articleDir(slug), "speech.md"), "utf8");
}

export async function listArticles(): Promise<ArticleMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(ARTICLES_DIR);
  } catch {
    return [];
  }
  const metas = await Promise.all(entries.map((slug) => loadMeta(slug)));
  return metas
    .filter((meta): meta is ArticleMeta => meta !== null)
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

/** Existing article with the same canonical URL, if any. */
export async function findBySource(
  canonicalUrl: string,
): Promise<ArticleMeta | null> {
  const id = articleId(canonicalUrl);
  const all = await listArticles();
  return all.find((meta) => meta.id === id) ?? null;
}

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { FEED, PUBLIC_DIR, SITE_URL } from "./config.ts";
import { formatDuration } from "./audio.ts";
import type { ArticleMeta } from "./store.ts";

export async function generateSite(articles: ArticleMeta[]): Promise<string> {
  const html = `<!doctype html>
<html lang="${esc(FEED.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(FEED.title)}</title>
<link rel="alternate" type="application/rss+xml" title="${esc(FEED.title)}" href="feed.xml">
<style>
  :root { color-scheme: light dark; --fg: #16181d; --muted: #5d6472; --bg: #fbfbf9; --line: #e3e2dd; --accent: #2f5eb3; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e9eaee; --muted: #9aa1b1; --bg: #14161a; --line: #2a2e36; --accent: #8fb0f0; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  .sub { color: var(--muted); margin: 0 0 2rem; }
  .sub a { color: var(--accent); }
  article { border-top: 1px solid var(--line); padding: 1.5rem 0; }
  article h2 { font-size: 1.1rem; margin: 0 0 .35rem; }
  article h2 a { color: inherit; text-decoration: none; }
  article h2 a:hover { text-decoration: underline; }
  .meta { color: var(--muted); font-size: .85rem; margin: 0 0 .75rem; }
  .excerpt { color: var(--muted); margin: 0 0 .9rem; }
  audio { width: 100%; }
  .empty { color: var(--muted); border-top: 1px solid var(--line); padding-top: 1.5rem; }
</style>
</head>
<body>
<main>
  <h1>${esc(FEED.title)}</h1>
  <p class="sub">${esc(FEED.description)} &middot; <a href="feed.xml">RSS feed</a></p>
${articles.length ? articles.map(card).join("\n") : '  <p class="empty">Nothing ingested yet.</p>'}
</main>
</body>
</html>
`;
  const file = path.join(PUBLIC_DIR, "index.html");
  await writeFile(file, html, "utf8");
  return file;
}

function card(article: ArticleMeta): string {
  const meta = [
    article.author,
    article.publishedAt,
    formatDuration(article.durationSeconds),
  ]
    .filter(Boolean)
    .map((value) => esc(String(value)))
    .join(" &middot; ");

  return `  <article>
    <h2><a href="${esc(article.source)}">${esc(article.title)}</a></h2>
    <p class="meta">${meta}</p>
    ${article.excerpt ? `<p class="excerpt">${esc(article.excerpt)}</p>` : ""}
    <audio controls preload="none" src="${esc(article.audio.replace(/^\//, ""))}"></audio>
  </article>`;
}

export function feedUrl(): string {
  return `${SITE_URL}/feed.xml`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

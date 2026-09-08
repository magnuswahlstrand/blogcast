import { writeFile } from "node:fs/promises";
import path from "node:path";
import { AUDIO_BASE_URL, FEED, PUBLIC_DIR, SITE_URL } from "./config.ts";
import { formatDuration } from "./audio.ts";
import type { ArticleMeta } from "./store.ts";

export async function generateFeed(articles: ArticleMeta[]): Promise<string> {
  const now = new Date();
  const items = articles.map(itemXml).join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${esc(FEED.title)}</title>
    <link>${esc(SITE_URL)}/</link>
    <description>${esc(FEED.description)}</description>
    <language>${esc(FEED.language)}</language>
    <lastBuildDate>${rfc822(now)}</lastBuildDate>
    <generator>blogcast</generator>
    <atom:link href="${esc(SITE_URL)}/feed.xml" rel="self" type="application/rss+xml"/>
    <itunes:author>${esc(FEED.author)}</itunes:author>
    <itunes:summary>${esc(FEED.description)}</itunes:summary>
    <itunes:explicit>false</itunes:explicit>
    <itunes:block>Yes</itunes:block>
    <itunes:owner>
      <itunes:name>${esc(FEED.author)}</itunes:name>
      <itunes:email>${esc(FEED.email)}</itunes:email>
    </itunes:owner>
${items}
  </channel>
</rss>
`;

  const file = path.join(PUBLIC_DIR, "feed.xml");
  await writeFile(file, xml, "utf8");
  return file;
}

function itemXml(article: ArticleMeta): string {
  // Pocket Casts treats a feed without pubDate as invalid, so fall back to the
  // ingest time rather than emitting an item with no date at all.
  const published = article.publishedAt
    ? new Date(`${article.publishedAt}T08:00:00Z`)
    : new Date(article.addedAt);

  return `    <item>
      <title>${esc(article.title)}</title>
      <link>${esc(article.source)}</link>
      <guid isPermaLink="false">blogcast:${esc(article.id)}</guid>
      <pubDate>${rfc822(published)}</pubDate>
      <description>${esc(description(article))}</description>
      <itunes:author>${esc(article.author ?? FEED.author)}</itunes:author>
      <itunes:duration>${formatDuration(article.durationSeconds)}</itunes:duration>
      <itunes:explicit>false</itunes:explicit>
      <enclosure url="${esc(AUDIO_BASE_URL + article.audio)}" length="${article.audioBytes}" type="audio/mpeg"/>
    </item>`;
}

function description(article: ArticleMeta): string {
  const parts = [article.excerpt ?? "", `Original: ${article.source}`];
  if (article.author) parts.unshift(`By ${article.author}.`);
  return parts.filter(Boolean).join("\n\n");
}

/** toUTCString() already yields "Wed, 02 Sep 2026 08:00:00 GMT" - valid RFC 822. */
export function rfc822(date: Date): string {
  return date.toUTCString();
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

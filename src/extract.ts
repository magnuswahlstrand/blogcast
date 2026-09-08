import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

export type Extracted = {
  title: string;
  author: string | null;
  publishedAt: string | null; // ISO date (YYYY-MM-DD) when we can find one
  canonicalUrl: string;
  excerpt: string | null;
  siteName: string | null;
  contentHtml: string;
  textContent: string;
};

/**
 * Deterministic extraction only - no model involved. Readability handles the
 * article body; the metadata below comes from <meta>/JSON-LD, in that order of
 * preference, because Readability's byline is unreliable on many blogs.
 */
export function extractArticle(html: string, url: string): Extracted {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  // Readability mutates the document, so read metadata before parsing.
  const meta = readMetadata(doc);
  const canonicalUrl =
    doc.querySelector("link[rel=canonical]")?.getAttribute("href") ??
    meta.ogUrl ??
    url;

  const article = new Readability(doc).parse();
  if (!article?.content) {
    throw new Error(`Readability found no article content at ${url}`);
  }

  return {
    title: (article.title || meta.title || "Untitled").trim(),
    author: article.byline?.trim() || meta.author || null,
    publishedAt: meta.published,
    canonicalUrl: new URL(canonicalUrl, url).toString(),
    excerpt: article.excerpt?.trim() || null,
    siteName:
      article.siteName || meta.siteName || new URL(url).hostname.replace(/^www\./, ""),
    contentHtml: article.content,
    textContent: article.textContent ?? "",
  };
}

type Meta = {
  title: string | null;
  author: string | null;
  published: string | null;
  siteName: string | null;
  ogUrl: string | null;
};

function readMetadata(doc: Document): Meta {
  const attr = (selector: string, name = "content") =>
    doc.querySelector(selector)?.getAttribute(name)?.trim() || null;

  const jsonLd = readJsonLd(doc);

  return {
    title:
      attr('meta[property="og:title"]') ??
      jsonLd?.headline ??
      doc.title?.trim() ??
      null,
    author:
      attr('meta[name="author"]') ??
      attr('meta[property="article:author"]') ??
      jsonLdAuthor(jsonLd) ??
      null,
    published:
      toIsoDate(
        attr('meta[property="article:published_time"]') ??
          attr('meta[name="date"]') ??
          attr("time[datetime]", "datetime") ??
          jsonLd?.datePublished ??
          null,
      ) ?? visibleDate(doc),
    siteName: attr('meta[property="og:site_name"]'),
    ogUrl: attr('meta[property="og:url"]'),
  };
}

/**
 * Plenty of blogs ship no date metadata at all and only render it in the
 * header. Read the usual containers rather than give up - a missing pubDate
 * makes the feed invalid in some podcast clients.
 */
const DATE_CONTAINERS = [
  "time",
  ".post-meta",
  ".post-date",
  ".published",
  "[class*=date]",
  "header",
];

const DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/i,
  /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i,
];

function visibleDate(doc: Document): string | null {
  for (const selector of DATE_CONTAINERS) {
    for (const node of doc.querySelectorAll(selector)) {
      const text = node.textContent?.slice(0, 400) ?? "";
      for (const pattern of DATE_PATTERNS) {
        const iso = toIsoDate(pattern.exec(text)?.[0] ?? null);
        if (iso) return iso;
      }
    }
  }
  return null;
}

type JsonLd = {
  headline?: string;
  datePublished?: string;
  author?: unknown;
};

function readJsonLd(doc: Document): JsonLd | null {
  const nodes = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const node of nodes) {
    try {
      const parsed: unknown = JSON.parse(node.textContent ?? "");
      const candidates = Array.isArray(parsed)
        ? parsed
        : [parsed, ...((parsed as { "@graph"?: unknown[] })?.["@graph"] ?? [])];
      for (const candidate of candidates) {
        const obj = candidate as JsonLd & { "@type"?: string | string[] };
        const type = ([] as string[]).concat(obj?.["@type"] ?? []);
        if (type.some((t) => /Article|BlogPosting|NewsArticle/.test(t))) {
          return obj;
        }
      }
    } catch {
      // A malformed JSON-LD block is common and never fatal.
    }
  }
  return null;
}

function jsonLdAuthor(jsonLd: JsonLd | null): string | null {
  const author = jsonLd?.author;
  if (!author) return null;
  const first = Array.isArray(author) ? author[0] : author;
  if (typeof first === "string") return first;
  const name = (first as { name?: string })?.name;
  return typeof name === "string" ? name : null;
}

export function toIsoDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  // "September 2, 2026" parses as local midnight; reading it back as UTC would
  // shift the publication date a day west of anyone east of Greenwich.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
  const pad = (n: number) => String(n).padStart(2, "0");
  return hasZone
    ? date.toISOString().slice(0, 10)
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

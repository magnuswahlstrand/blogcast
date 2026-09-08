import { createHash } from "node:crypto";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
});
turndown.use(gfm);

turndown.remove(["script", "style", "noscript", "iframe"]);

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

const BOILERPLATE = /subscrib|email updates|sharing it on|hacker news|newsletter|follow me on|related post|continue reading|shares tags with/i;

/**
 * Readability keeps a blog's post footer (subscribe box, share links, "related
 * post" teaser) because it sits inside the article container. It is not the
 * author's prose and nobody wants it read aloud, so drop trailing sections -
 * and only trailing ones - that look like it.
 */
export function trimTrailingBoilerplate(markdown: string): string {
  const sections = markdown.split(/\n\s*(?:\*\s*\*\s*\*|---|___)\s*\n/);
  while (sections.length > 1) {
    const last = sections[sections.length - 1].trim();
    const isSmallAndBoilerplate = last.length < 1500 && BOILERPLATE.test(last);
    if (!last || isSmallAndBoilerplate) {
      sections.pop();
      continue;
    }
    break;
  }
  return sections.join("\n\n* * *\n\n").trim();
}

export function slugify(title: string, publishedAt: string | null): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/, "");
  const date = publishedAt ?? new Date().toISOString().slice(0, 10);
  return `${date}-${base || "article"}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function frontmatter(fields: Record<string, string | null>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}: ${yamlScalar(v as string)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

function yamlScalar(value: string): string {
  return /^[\w][\w .:/,'()&-]*$/.test(value) && !value.includes(": ")
    ? value
    : JSON.stringify(value);
}

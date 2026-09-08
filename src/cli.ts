import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AUDIO_DIR, PUBLIC_DIR, SITE_URL, TTS } from "./config.ts";
import { fetchUrl } from "./fetch.ts";
import { extractArticle } from "./extract.ts";
import {
  htmlToMarkdown,
  sha256,
  slugify,
  trimTrailingBoilerplate,
} from "./markdown.ts";
import { prepareForSpeech } from "./speech.ts";
import { chunkSpeech } from "./chunk.ts";
import { concatMp3, probe, synthesizeChunks } from "./audio.ts";
import { getTts } from "./tts/index.ts";
import {
  articleId,
  findBySource,
  listArticles,
  loadMeta,
  renderArticleMd,
  saveArticle,
  type ArticleMeta,
} from "./store.ts";
import { generateFeed } from "./rss.ts";
import { generateSite } from "./site.ts";
import { verifyArticle } from "./verify.ts";

const USAGE = `blogcast - turn blog posts into a private podcast feed

  pnpm ingest <url> [--model] [--force] [--tts=say|openai|google]
                    [--author="Name"] [--published=YYYY-MM-DD]
  pnpm build                     regenerate feed.xml + index.html from content/
  pnpm verify [slug]             check speech.md against article.md

--model sends code blocks and tables to Claude for a spoken rewrite; without
it, rules handle them (bluntly, but with no API key and no risk of dropped
prose).
  pnpm list                      list ingested articles

Env:
  BLOGCAST_SITE_URL        public base URL (default ${SITE_URL})
  BLOGCAST_AUDIO_BASE_URL  where MP3s are served from (default: the site URL)
  BLOGCAST_TTS             say | openai | google    (default ${TTS.provider})
  BLOGCAST_VOICE           provider-specific voice id
  ANTHROPIC_API_KEY        required only with --model
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
  const positional = rest.filter((arg) => !arg.startsWith("--"));
  const value = (name: string) =>
    [...flags].find((flag) => flag.startsWith(`--${name}=`))?.slice(name.length + 3);

  switch (command) {
    case "ingest": {
      const url = positional[0];
      if (!url) throw new Error("usage: pnpm ingest <url>");
      await ingest(url, {
        useModel: flags.has("--model"),
        force: flags.has("--force"),
        tts: value("tts"),
        author: value("author"),
        published: value("published"),
      });
      break;
    }
    case "build":
      await build();
      break;
    case "verify":
      await verify(positional[0]);
      break;
    case "list": {
      const articles = await listArticles();
      for (const article of articles) {
        console.log(
          `${article.slug}\n  ${article.title}\n  ${article.source}\n  ${article.audio} (${article.durationSeconds}s)`,
        );
      }
      if (!articles.length) console.log("(nothing ingested yet)");
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

type IngestOptions = {
  useModel: boolean;
  force: boolean;
  tts?: string;
  /** Overrides for blogs that publish no author/date metadata at all. */
  author?: string;
  published?: string;
};

async function ingest(url: string, options: IngestOptions) {
  const tts = getTts(options.tts);

  console.log(`fetching   ${url}`);
  const { html, finalUrl } = await fetchUrl(url);

  const extracted = extractArticle(html, finalUrl);
  const article = {
    ...extracted,
    author: options.author ?? extracted.author,
    publishedAt: options.published ?? extracted.publishedAt,
  };
  const slug = slugify(article.title, article.publishedAt);
  const existing =
    (await findBySource(article.canonicalUrl)) ?? (await loadMeta(slug));
  console.log(`extracted  ${article.title}${article.author ? ` - ${article.author}` : ""}`);

  const markdown = trimTrailingBoilerplate(htmlToMarkdown(article.contentHtml));
  const { speech, usedModel } = await prepareForSpeech({
    title: article.title,
    author: article.author,
    publishedAt: article.publishedAt,
    markdown,
    useModel: options.useModel,
  });
  const speechHash = sha256(speech);
  console.log(
    `speech     ${speech.length} chars (${usedModel ? "model + rules" : "rules only"})`,
  );

  const audioRelative = `/audio/${slug}.mp3`;
  const audioFile = path.join(AUDIO_DIR, `${slug}.mp3`);
  const unchanged =
    existing?.speechHash === speechHash && existing.voice === tts.id;

  if (unchanged && !options.force) {
    console.log(`audio      unchanged, reusing ${audioRelative}`);
  } else {
    const chunks = chunkSpeech(speech);
    console.log(`tts        ${chunks.length} chunk(s) via ${tts.id}`);
    const { files, rendered, cached } = await synthesizeChunks(chunks, tts, {
      force: options.force,
    });
    console.log(`tts        ${rendered} rendered, ${cached} from cache`);
    await concatMp3(files, audioFile, {
      title: article.title,
      artist: article.author,
    });
  }

  const stats = await probe(audioFile);
  const meta: ArticleMeta = {
    id: articleId(article.canonicalUrl),
    slug,
    source: article.canonicalUrl,
    title: article.title,
    author: article.author,
    publishedAt: article.publishedAt,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    excerpt: article.excerpt,
    siteName: article.siteName,
    speechHash,
    speechUsedModel: usedModel,
    voice: tts.id,
    audio: audioRelative,
    audioBytes: stats.bytes,
    durationSeconds: stats.seconds,
  };

  await saveArticle(slug, {
    articleMd: renderArticleMd(meta, markdown),
    speechMd: speech,
    meta,
  });
  console.log(`saved      content/articles/${slug}/`);
  console.log(`audio      ${audioRelative} (${stats.duration}, ${kb(stats.bytes)})`);

  await report(await verifyArticle(slug), slug);
  await build();
}

async function build() {
  await mkdir(AUDIO_DIR, { recursive: true });
  const articles = await listArticles();
  await generateFeed(articles);
  await generateSite(articles);
  console.log(
    `built      ${path.relative(process.cwd(), PUBLIC_DIR)}/index.html + feed.xml (${articles.length} episode(s))`,
  );
}

async function verify(slug?: string) {
  const slugs = slug
    ? [slug]
    : (await listArticles()).map((article) => article.slug);
  let failed = false;
  for (const current of slugs) {
    const findings = await verifyArticle(current);
    failed ||= findings.some((finding) => finding.level === "error");
    await report(findings, current);
  }
  if (failed) process.exitCode = 1;
}

async function report(findings: Awaited<ReturnType<typeof verifyArticle>>, slug: string) {
  if (!findings.length) {
    console.log(`verify     ${slug}: ok`);
    return;
  }
  for (const finding of findings) {
    console.log(`verify     ${slug}: ${finding.level.toUpperCase()} ${finding.message}`);
  }
}

const kb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

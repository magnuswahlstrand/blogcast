import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, "..");
export const ARTICLES_DIR = path.join(ROOT, "content", "articles");
export const PUBLIC_DIR = path.join(ROOT, "public");
export const AUDIO_DIR = path.join(PUBLIC_DIR, "audio");
export const CHUNK_CACHE_DIR = path.join(ROOT, ".cache", "audio");

/**
 * Public base URL of the generated site. Everything in feed.xml is absolute,
 * so this is the one value that must be right before you publish.
 */
export const SITE_URL = (
  process.env.BLOGCAST_SITE_URL ?? "https://example.github.io/blogcast"
).replace(/\/+$/, "");

/**
 * Where the MP3s are actually served from. Defaults to the site itself (v0:
 * audio committed alongside the pages); point it at R2/S3/a CDN and the feed
 * moves off Git with no code change - <enclosure> does not care where the
 * binary lives.
 */
export const AUDIO_BASE_URL = (
  process.env.BLOGCAST_AUDIO_BASE_URL ?? SITE_URL
).replace(/\/+$/, "");

export const FEED = {
  title: process.env.BLOGCAST_FEED_TITLE ?? "Blogcast",
  description:
    process.env.BLOGCAST_FEED_DESCRIPTION ??
    "Blog posts read aloud. Personal, unlisted feed.",
  author: process.env.BLOGCAST_FEED_AUTHOR ?? "Blogcast",
  email: process.env.BLOGCAST_FEED_EMAIL ?? "noreply@example.com",
  language: process.env.BLOGCAST_FEED_LANGUAGE ?? "en",
};

/** say = macOS `say`, works offline and needs no API key. */
export type TtsProvider = "say" | "openai" | "google";

export const TTS = {
  provider: (process.env.BLOGCAST_TTS ?? "say") as TtsProvider,
  voice: process.env.BLOGCAST_VOICE ?? "",
  model: process.env.BLOGCAST_TTS_MODEL ?? "",
};

export const SPEECH_MODEL = process.env.BLOGCAST_SPEECH_MODEL ?? "claude-opus-5";

/** Target size of one TTS chunk, in characters (~2-4 minutes of audio). */
export const CHUNK_TARGET_CHARS = Number(
  process.env.BLOGCAST_CHUNK_CHARS ?? 2400,
);

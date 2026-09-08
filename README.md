# blogcast

A static podcast compiler. Point it at a blog post URL; it produces an MP3, an
RSS item and a page, all as files you can commit and serve from GitHub Pages.

```
url -> fetch -> Readability -> Markdown -> speech text -> chunked TTS
    -> ffmpeg concat -> public/audio/<slug>.mp3 + feed.xml + index.html
```

## Quick start

```bash
pnpm install                       # needs Node 24+ (runs .ts directly) and ffmpeg
export BLOGCAST_SITE_URL="https://<you>.github.io/blogcast"
pnpm ingest https://www.seangoedecke.com/how-to-protect-yourself-from-workslop/
open public/index.html
```

By default the speech transform is rules-only, so the whole pipeline runs
offline with the macOS `say` voice and no API keys at all. Add `--model` (with
`ANTHROPIC_API_KEY` set) to have Claude rewrite code blocks and tables into
spoken prose.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm ingest <url>` | Full pipeline for one article, then rebuilds the site |
| `pnpm build` | Regenerate `feed.xml` + `index.html` from `content/` |
| `pnpm verify [slug]` | Check `speech.md` against `article.md` (exit 1 on errors) |
| `pnpm list` | List ingested articles |

Ingest flags: `--model`, `--force`, `--tts=say|openai|google`,
`--author="Name"`, `--published=YYYY-MM-DD`.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `BLOGCAST_SITE_URL` | `https://example.github.io/blogcast` | Base URL for the feed |
| `BLOGCAST_AUDIO_BASE_URL` | the site URL | Point at R2/S3 to move audio off Git |
| `BLOGCAST_TTS` | `say` | `say`, `openai`, `google` |
| `BLOGCAST_VOICE` | provider default | e.g. `Daniel`, `alloy`, `en-US-Chirp3-HD-Charon` |
| `BLOGCAST_TTS_MODEL` | provider default | `gpt-4o-mini-tts`; on `google`, the language code |
| `BLOGCAST_SPEECH_MODEL` | `claude-opus-5` | Model for the speech transform |
| `BLOGCAST_CHUNK_CHARS` | `2400` | Target TTS chunk size |
| `BLOGCAST_FEED_*` | see `src/config.ts` | `TITLE`, `DESCRIPTION`, `AUTHOR`, `EMAIL`, `LANGUAGE` |

Secrets: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. Google TTS uses ADC
(`gcloud auth application-default login`, or `GOOGLE_APPLICATION_CREDENTIALS`).

## How it is put together

**Extraction is deterministic.** `@mozilla/readability` + `jsdom` produce the
article body; title, byline and date come from `<meta>`, JSON-LD, and - for the
many blogs that publish no date metadata at all - a conservative scan of the
usual header containers. No model is involved, because none is needed.

**Two representations, on purpose.**

```
content/articles/2026-09-02-how-to-protect-yourself-from-workslop/
  article.md      archival, close to the source, frontmatter + Markdown
  metadata.json   id, source, dates, audio path, size, duration, voice
  speech.md       intentionally lossy, written to be read aloud
```

`article.md` is never rewritten by a model. `speech.md` is, but only partially:

- **Rules** handle links (visible text only), images, headings, blockquotes
  (`Quote: ...`), footnote markers, heading permalinks and inline code.
- **The model**, with `--model`, sees only what is left - code blocks and
  tables, handed over as `{{CODE:...}}` / `{{TABLE:...}}` placeholders under a
  narrow contract ("do not summarize or omit prose", "never introduce new
  claims"). By default rules cover those too, more bluntly: a table becomes
  "A table with columns: ...", a long code block becomes "The author now shows
  a 12-line ts code example."

**`pnpm verify` is the guard rail.** The real failure mode is not extraction -
it is a model quietly deciding a paragraph does not need reading. Because
`article.md` is kept verbatim, `speech.md` can be checked against it: heading
coverage, prose word-count ratio, distinctive terms that vanished, and leftover
placeholders or URLs. `ingest` runs it automatically.

**Chunked TTS with a content-addressed cache.** `speech.md` is split on
semantic boundaries (headings first, then paragraphs, then sentences) into
~2-4 minute pieces. Each chunk's MP3 is cached under `.cache/audio/` keyed by
`sha256(normalized text)` + voice, then `ffmpeg` concatenates them. Editing one
paragraph re-renders one chunk, not a 45-minute article.

**TTS providers are swappable** behind one interface (`src/tts/`):
`say` (macOS, free, offline - the default so the pipeline runs before you pick
a paid provider), `openai`, `google` (Chirp 3 HD). Add a provider by
implementing `synthesize(text): Promise<Buffer>` and registering it in
`src/tts/index.ts`; `audio.ts` owns the atomic write into the chunk cache.

**Idempotent by canonical URL.** `id` is `sha256:<canonical url>`; re-ingesting
the same post reuses `addedAt` and skips synthesis entirely when the speech
hash and voice are unchanged.

## Publishing

`public/` is the site root. With GitHub Pages set to deploy from Actions,
`.github/workflows/pages.yml` publishes it on every push to `main`.

The feed carries `<pubDate>` on every item (Pocket Casts rejects feeds without
it), an `<enclosure>` with real byte length and `<itunes:duration>`, and
`<itunes:block>Yes</itunes:block>` so it stays out of directories.

### Moving audio off Git later

Committing MP3s is fine for an experiment and bad long-term - Git keeps every
old binary forever. When that starts to hurt:

1. Sync `public/audio/` to R2/S3 and stop committing it (already gitignored).
2. Set `BLOGCAST_AUDIO_BASE_URL=https://audio.example.com`.

Nothing else changes; `<enclosure>` does not care where the binary lives.

## Known gaps

- The `--model` pass has not been exercised against a live API key here -
  everything in this repo was validated on the rules-only path.
- Google TTS is typechecked but unverified end to end: the local ADC
  credentials are expired (`invalid_grant`). Re-run
  `gcloud auth application-default login` and ingest once to confirm.
- Very long articles are sent to the model in one request; splitting the model
  pass per section is the obvious next step if you hit output limits.
- `say` is macOS-only. On Linux, use `openai`/`google` or add a Piper provider.

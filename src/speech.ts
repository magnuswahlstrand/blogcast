import Anthropic from "@anthropic-ai/sdk";
import { SPEECH_MODEL } from "./config.ts";

/**
 * The speech representation is deliberately lossy, and deliberately produced in
 * two passes: everything that can be decided by a rule is decided by a rule,
 * and the model only ever sees what is left (code blocks, tables).
 */
export type SpeechOptions = {
  title: string;
  author: string | null;
  publishedAt: string | null;
  markdown: string;
  /** Opt-in: rules handle code and tables well enough for most articles. */
  useModel: boolean;
};

export async function prepareForSpeech(
  options: SpeechOptions,
): Promise<{ speech: string; usedModel: boolean }> {
  const deterministic = deterministicPass(options.markdown);
  const needsModel = /\{\{(CODE|TABLE):/.test(deterministic);

  let usedModel = false;
  let body: string;
  if (options.useModel && needsModel) {
    body = await modelPass(deterministic, options.title);
    usedModel = true;
  } else {
    body = fallbackPass(deterministic);
  }

  return { speech: `${preamble(options)}\n\n${body.trim()}\n`, usedModel };
}

function preamble(options: SpeechOptions): string {
  const lines = [`${stripTrailingPunctuation(options.title)}.`];
  if (options.author) lines.push(`By ${options.author}.`);
  if (options.publishedAt) {
    lines.push(`Published ${spokenDate(options.publishedAt)}.`);
  }
  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// Pass 1 - rules only. Never calls a model, never rewrites prose.
// ---------------------------------------------------------------------------

export function deterministicPass(markdown: string): string {
  const extracted = extractFences(markdown);
  const lines = extracted.text.split("\n");
  const out: string[] = [];
  let tableRows: string[] = [];

  const flushTable = () => {
    if (tableRows.length === 0) return;
    out.push(`{{TABLE:${encode(tableRows.join("\n"))}}}`);
    tableRows = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/<!--[\s\S]*?-->/g, "");

    if (/^\s*\|.*\|\s*$/.test(line)) {
      tableRows.push(line.trim());
      continue;
    }
    flushTable();

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) continue; // horizontal rule
    if (/^\s*\[[^\^\]]+\]:\s*http/i.test(line)) continue; // link reference def

    // A footnote definition is still the author's prose - label it, don't drop it.
    const text = cleanInline(
      line.replace(/^(\s*)\[\^[^\]]+\]:\s*/, "$1Footnote: "),
    );

    if (/^\s*>/.test(text)) {
      const quote = text.replace(/^\s*>\s?/, "").trim();
      out.push(quote ? `Quote: ${quote}` : "");
      continue;
    }

    out.push(text);
  }
  flushTable();

  return restoreFences(out.join("\n"), extracted.fences)
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Inline Markdown that no one wants read aloud. Shared by lines and table cells. */
function cleanInline(input: string): string {
  return input
    .replace(
      /!\[([^\]]*)\]\([^)]*\)(\s*[.,;:!?])?/g,
      (_m, alt: string, punctuation: string | undefined) =>
        alt.trim() ? `Image: ${alt.trim()}${punctuation ?? "."}` : "",
    )
    // Footnote markers and back-links ("[1](#fn-1)", "[|](#fnref-1)") read as
    // noise. Only numeric or symbol link text qualifies, so that a real
    // in-page link like "[API](#api)" keeps its visible text.
    .replace(/\[(?:\d{1,3}|[^\w\s]{1,2})?\]\(#[^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // link -> visible text
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1") // reference link
    .replace(/<(https?:\/\/[^>]+)>/g, "") // bare autolink
    .replace(/\bhttps?:\/\/\S+/g, "") // bare URL
    .replace(/\[\^[^\]]+\]/g, "") // footnote marker
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(?<!\w)([*_])(?!\s)(.+?)(?<!\s)\1(?!\w)/g, "$2")
    .replace(/\s+([.,;:!?])/g, "$1"); // stray space left by a removal
}

const FENCE_TOKEN = "@@FENCE";

function extractFences(markdown: string): { text: string; fences: string[] } {
  const fences: string[] = [];
  const text = markdown.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, (block) => {
    fences.push(block);
    return `${FENCE_TOKEN}${fences.length - 1}@@`;
  });
  return { text, fences };
}

function restoreFences(text: string, fences: string[]): string {
  return text.replace(
    new RegExp(`${FENCE_TOKEN}(\\d+)@@`, "g"),
    (_m, index: string) => `{{CODE:${encode(fences[Number(index)])}}}`,
  );
}

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
const decode = (value: string) => Buffer.from(value, "base64").toString("utf8");

// ---------------------------------------------------------------------------
// Pass 2a - rules for the leftovers, when no model is used (or as a net for a
// placeholder the model failed to resolve).
// ---------------------------------------------------------------------------

function fallbackPass(text: string): string {
  return text
    .replace(/\{\{CODE:([A-Za-z0-9+/=]+)\}\}/g, (_m, b64: string) =>
      codeToSpeech(decode(b64)),
    )
    .replace(/\{\{TABLE:([A-Za-z0-9+/=]+)\}\}/g, (_m, b64: string) =>
      tableToSpeech(decode(b64)),
    );
}

function codeToSpeech(block: string): string {
  const lang = /^```([\w+#.-]*)/.exec(block)?.[1] ?? "";
  const body = block.replace(/^```[^\n]*\n/, "").replace(/```[ \t]*$/, "");
  const lineCount = body.trim().split("\n").length;
  if (lineCount <= 3) {
    return `Code${lang ? ` in ${lang}` : ""}: ${body.trim().replace(/\s+/g, " ")}`;
  }
  return `The author now shows a ${lineCount}-line${lang ? ` ${lang}` : ""} code example.`;
}

function tableToSpeech(table: string): string {
  const rows = table
    .split("\n")
    .filter((row) => !/^\|[\s:|-]+\|$/.test(row))
    .map((row) =>
      row
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cleanInline(cell).trim()),
    );
  const [header, ...body] = rows;
  if (!header) return "";
  return [
    `A table with columns: ${header.join(", ")}.`,
    ...body.map(
      (cells) =>
        `${cells
          .map((cell, index) => `${header[index] ?? "value"}: ${cell}`)
          .join("; ")}.`,
    ),
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Pass 2b - the model, under a narrow contract.
// ---------------------------------------------------------------------------

const SPEECH_CONTRACT = `Convert this article to text suitable for spoken audio.

Rules:
- Do not summarize or omit prose. Every sentence the author wrote must survive.
- Preserve headings, each on its own line.
- Remove navigation and URLs.
- For hyperlinks, read only their visible text.
- For simple code snippets, read them naturally.
- For long code blocks, explain briefly what the code demonstrates instead of
  reading every symbol.
- Convert tables into natural sentences.
- Never introduce new claims, opinions, or transitions the author did not write.
- Placeholders of the form {{CODE:base64}} and {{TABLE:base64}} hold
  base64-encoded Markdown. Decode each one and replace the placeholder with its
  spoken form. No placeholder may remain in your output.

Return only the transformed text: no preamble, no commentary, no code fences.`;

async function modelPass(text: string, title: string): Promise<string> {
  let client: Anthropic;
  try {
    client = new Anthropic();
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message.split("\n")[0] : error}\n` +
        "Set ANTHROPIC_API_KEY, or pass --no-model to use the rules-only transform.",
    );
  }
  const stream = client.messages.stream({
    model: SPEECH_MODEL,
    max_tokens: 64000,
    output_config: { effort: "low" },
    system: SPEECH_CONTRACT,
    messages: [
      {
        role: "user",
        content: `Article title: ${title}\n\n<article>\n${text}\n</article>`,
      },
    ],
  });

  const response = await stream.finalMessage();
  const output = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!output) throw new Error("Speech model returned no text");
  // Net for a placeholder the model left behind - shipping base64 to a TTS
  // engine is a much worse failure than a slightly flat sentence.
  return fallbackPass(output);
}

// ---------------------------------------------------------------------------

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.!?]+$/, "").trim();
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const ORDINALS = [
  "", "first", "second", "third", "fourth", "fifth", "sixth", "seventh",
  "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth",
  "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth",
  "nineteenth", "twentieth", "twenty-first", "twenty-second", "twenty-third",
  "twenty-fourth", "twenty-fifth", "twenty-sixth", "twenty-seventh",
  "twenty-eighth", "twenty-ninth", "thirtieth", "thirty-first",
];

/** "2026-09-02" -> "September second, twenty twenty-six" */
export function spokenDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return `${MONTHS[month - 1]} ${ORDINALS[day]}, ${spokenYear(year)}`;
}

function spokenYear(year: number): string {
  const high = Math.floor(year / 100);
  const low = year % 100;
  if (low === 0) return `${numberWord(high)} hundred`;
  if (low < 10) return `${numberWord(high)} oh ${numberWord(low)}`;
  return `${numberWord(high)} ${numberWord(low)}`;
}

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = [
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty",
  "ninety",
];

function numberWord(value: number): string {
  if (value < 20) return ONES[value];
  const tens = TENS[Math.floor(value / 10)];
  const ones = value % 10;
  return ones ? `${tens}-${ONES[ones]}` : tens;
}

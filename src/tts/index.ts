import { TTS, type TtsProvider } from "../config.ts";
import { sayTts } from "./say.ts";
import { openaiTts } from "./openai.ts";
import { googleTts } from "./google.ts";

export type Tts = {
  /** Stable identifier - part of the audio cache key, so switching voice regenerates. */
  id: string;
  synthesize(text: string): Promise<Buffer>;
};

const PROVIDERS: Record<TtsProvider, (voice: string, model: string) => Tts> = {
  say: sayTts,
  openai: openaiTts,
  google: googleTts,
};

export function getTts(override?: string): Tts {
  const name = (override ?? TTS.provider) as TtsProvider;
  const factory = PROVIDERS[name];
  if (!factory) {
    throw new Error(
      `Unknown TTS provider "${name}". Options: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  return factory(TTS.voice, TTS.model);
}

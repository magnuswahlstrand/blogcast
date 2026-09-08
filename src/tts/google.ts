import textToSpeech from "@google-cloud/text-to-speech";
import type { Tts } from "./index.ts";

/**
 * Google Cloud TTS. Auth is ADC - `gcloud auth application-default login`
 * locally, or GOOGLE_APPLICATION_CREDENTIALS pointing at a service account key.
 *
 * Chirp 3 HD voices take plain text only (no SSML) and cap a request at 5000
 * bytes, which is well above our ~2400-character chunk target - but chunking is
 * driven by listening length, not by this limit, so check it rather than let
 * the API reject a long chunk.
 */
const MAX_REQUEST_BYTES = 5000;

export function googleTts(voice: string, model: string): Tts {
  const name = voice || "en-US-Chirp3-HD-Charon";
  const languageCode = model || name.split("-").slice(0, 2).join("-");
  const client = new textToSpeech.TextToSpeechClient();

  return {
    id: `google:${name}`,
    async synthesize(text) {
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > MAX_REQUEST_BYTES) {
        throw new Error(
          `Chunk is ${bytes} bytes; Google TTS accepts at most ${MAX_REQUEST_BYTES}. ` +
            "Lower BLOGCAST_CHUNK_CHARS.",
        );
      }

      const [response] = await client.synthesizeSpeech({
        input: { text },
        voice: { languageCode, name },
        audioConfig: { audioEncoding: "MP3" },
      });

      const audio = response.audioContent;
      if (!audio) throw new Error("Google TTS returned no audio content");
      return typeof audio === "string"
        ? Buffer.from(audio, "base64")
        : Buffer.from(audio);
    },
  };
}

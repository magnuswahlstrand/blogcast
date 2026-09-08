import type { Tts } from "./index.ts";

export function openaiTts(voice: string, model: string): Tts {
  const selectedVoice = voice || "alloy";
  const selectedModel = model || "gpt-4o-mini-tts";
  return {
    id: `openai:${selectedModel}:${selectedVoice}`,
    async synthesize(text) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: selectedModel,
          voice: selectedVoice,
          input: text,
          response_format: "mp3",
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI TTS ${res.status}: ${await res.text()}`);
      }
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

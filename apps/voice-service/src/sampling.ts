import type { VoiceSampling } from "./types.ts";

function audibleLength(text: string): number {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").length;
}

/**
 * GPT-SoVITS is especially prone to looping with a high top-k on a very short
 * Japanese line.  We never use k=1 (which the owner verified is unusable), but
 * deliberately reduce entropy for short acknowledgements.
 */
export function samplingFor(text: string): VoiceSampling {
  const length = audibleLength(text);
  // A normal one-sentence Japanese reply is often only 25–40 kana/kanji.  It
  // should still receive the more expressive profile rather than short-phrase
  // safeguards intended for things like 「おはよう」.
  const profile = length <= 12 ? "short" : length <= 30 ? "medium" : "long";
  const options = {
    short: { topK: 4, topP: 0.78, temperature: 0.66 },
    medium: { topK: 8, topP: 0.88, temperature: 0.82 },
    long: { topK: 15, topP: 0.96, temperature: 0.96 },
  }[profile];
  return { profile, ...options };
}

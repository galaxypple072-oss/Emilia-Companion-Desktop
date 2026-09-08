import type { VoiceEmotion, VoicePresetId, VoiceReferencePreset } from "./types.ts";

/**
 * These are the three auditioned references the owner selected.  They stay as
 * relative paths so the dataset may live outside the repository on Windows.
 */
export const VOICE_PRESETS: Record<Exclude<VoicePresetId, "natural">, VoiceReferencePreset> = {
  bright: {
    id: "bright",
    label: "开心明亮",
    source: "Home/vo_sim_emilia001#15 (home_birthday).wav",
    promptText: "今日は、スバルやみんなに、私の誕生日をお祝いしてもらえて、すごーく嬉しい!",
  },
  gentle: {
    id: "gentle",
    label: "温柔日常",
    source: "Home/vo_sim_emilia001#19 (home_morning_nrm).wav",
    promptText: "今、美精霊とお話してたのよ。朝の大切な日課で、大事な約束なの。",
  },
  soft: {
    id: "soft",
    label: "轻声晚安",
    source: "Home/vo_sim_emilia001#23 (home_night_nrm).wav",
    promptText: "今は朝の日課の延長戦。夜にしか会えない子もいるから大事なお話中。",
  },
};

const presetByEmotion: Record<VoiceEmotion, VoicePresetId> = {
  neutral: "natural",
  happy: "bright",
  concerned: "gentle",
  think: "gentle",
  surprise: "bright",
  shy: "soft",
  angry: "gentle",
  sad: "soft",
};

export function presetForEmotion(emotion: VoiceEmotion | undefined): VoicePresetId {
  const preset = presetByEmotion[emotion ?? "neutral"];
  if (!preset) throw new Error("emotion must be neutral, happy, concerned, think, surprise, shy, angry, or sad");
  return preset;
}

/** The first-seven-seconds #34 reference is intentionally external: its exact
 * source filename is still user-owned, so it must be configured rather than
 * guessed from the dataset. */
export function naturalPreset(source: string | undefined): VoiceReferencePreset | null {
  const file = source?.trim();
  if (!file) return null;
  return {
    id: "natural",
    label: "自然",
    source: file,
    clipStartSeconds: 0,
    clipDurationSeconds: 7,
    promptText: "オートってすごーく大きくて、人がたくさんで、いろんなお店があって。",
  };
}

export function resolvePreset(requested: VoicePresetId, naturalSource: string | undefined): {
  preset: VoiceReferencePreset;
  fallbackFrom: VoicePresetId | null;
} {
  if (requested === "natural") {
    const natural = naturalPreset(naturalSource);
    if (natural) return { preset: natural, fallbackFrom: null };
    return { preset: VOICE_PRESETS.gentle, fallbackFrom: "natural" };
  }
  const preset = VOICE_PRESETS[requested];
  if (!preset) throw new Error("preset must be natural, bright, gentle, or soft");
  return { preset, fallbackFrom: null };
}

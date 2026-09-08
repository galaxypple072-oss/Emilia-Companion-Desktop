export type VoiceEmotion = "neutral" | "happy" | "concerned" | "think" | "surprise" | "shy" | "angry" | "sad";

export type VoicePresetId = "natural" | "bright" | "gentle" | "soft";

export interface VoiceReferencePreset {
  id: VoicePresetId;
  label: string;
  /** A path relative to VOICE_REFERENCE_ROOT. */
  source: string;
  promptText: string;
  clipStartSeconds?: number;
  clipDurationSeconds?: number;
}

export interface VoiceSampling {
  profile: "short" | "medium" | "long";
  topK: number;
  topP: number;
  temperature: number;
}

export interface VoiceSynthesisRequest {
  text: string;
  emotion?: VoiceEmotion;
  preset?: VoicePresetId;
  variation?: number;
}

export interface VoiceSynthesisResult {
  id: string;
  preset: VoicePresetId;
  fallbackFrom: VoicePresetId | null;
  sampling: VoiceSampling;
  audioUrl: string;
  contentType: "audio/wav" | "audio/mpeg";
}

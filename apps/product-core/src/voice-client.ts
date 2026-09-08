import type { CompanionEmotion } from "./companion-bridge.ts";

export interface VoiceClientConfig { endpoint: string; token: string; enabled: boolean; }
export interface GeneratedVoice { id: string; mimeType: string; bytes: Uint8Array; }
export interface VoiceSynthesizer {
  synthesizeIfJapanese(text: string, emotion: CompanionEmotion): Promise<GeneratedVoice | null>;
}

export function loadVoiceClientConfig(env: NodeJS.ProcessEnv = process.env): VoiceClientConfig | null {
  if (env.VOICE_AUTO_PLAY_ENABLED?.trim().toLowerCase() !== "true") return null;
  const token = env.VOICE_SERVICE_TOKEN?.trim() ?? "";
  if (token.length < 24) throw new Error("VOICE_SERVICE_TOKEN must contain at least 24 characters when voice is enabled");
  const endpoint = (env.VOICE_SERVICE_ENDPOINT?.trim() || "http://127.0.0.1:9873").replace(/\/$/u, "");
  const url = new URL(endpoint);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("VOICE_SERVICE_ENDPOINT must remain local to Core");
  return { endpoint, token, enabled: true };
}

function isJapanese(text: string): boolean {
  const japanese = (text.match(/[\u3040-\u30ff]/gu) ?? []).length;
  // Japanese naturally contains shared Han characters (e.g. 大丈夫だよ), so
  // one kana is a stronger language signal than comparing Han counts.
  return japanese >= 1;
}

export class VoiceClient {
  private readonly config: VoiceClientConfig;

  constructor(config: VoiceClientConfig) {
    this.config = config;
  }

  async synthesizeIfJapanese(text: string, emotion: CompanionEmotion): Promise<GeneratedVoice | null> {
    if (!isJapanese(text)) return null;
    const response = await fetch(`${this.config.endpoint}/v1/synthesize`, {
      method: "POST", headers: { authorization: `Bearer ${this.config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ text, emotion }), signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`Voice service failed (${response.status})`);
    const payload = await response.json() as { audioUrl?: string; contentType?: string };
    if (!payload.audioUrl?.startsWith("/v1/audio/")) throw new Error("Voice service returned an invalid audio URL");
    const audio = await fetch(`${this.config.endpoint}${payload.audioUrl}`, { headers: { authorization: `Bearer ${this.config.token}` }, signal: AbortSignal.timeout(60_000) });
    if (!audio.ok) throw new Error(`Voice audio download failed (${audio.status})`);
    const bytes = new Uint8Array(await audio.arrayBuffer());
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error("Voice audio size is invalid");
    return { id: crypto.randomUUID(), mimeType: payload.contentType === "audio/mpeg" ? "audio/mpeg" : "audio/wav", bytes };
  }
}

/** Prefer a remote worker when one is healthy, while keeping the current
 * same-machine voice stack as a safe compatibility fallback. */
export class FallbackVoiceSynthesizer implements VoiceSynthesizer {
  private readonly providers: readonly VoiceSynthesizer[];

  constructor(providers: readonly (VoiceSynthesizer | null | undefined)[]) {
    this.providers = providers.filter((provider): provider is VoiceSynthesizer => Boolean(provider));
  }

  async synthesizeIfJapanese(text: string, emotion: CompanionEmotion): Promise<GeneratedVoice | null> {
    for (const provider of this.providers) {
      try {
        const voice = await provider.synthesizeIfJapanese(text, emotion);
        if (voice) return voice;
      } catch (error) {
        console.warn(`[voice] provider unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return null;
  }
}

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { GradioClient } from "./gradio-client.ts";
import { presetForEmotion, resolvePreset } from "./presets.ts";
import { samplingFor } from "./sampling.ts";
import type { VoiceSynthesisRequest, VoiceSynthesisResult } from "./types.ts";

export interface VoiceServiceConfig {
  apiToken: string;
  outputDirectory: string;
  referenceRoot: string;
  naturalReferenceSource?: string;
  gptWeight: string;
  sovitsWeight: string;
}

function localPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const relative = absolute.slice(resolve(root).length);
  if (relative.startsWith("..") || resolve(root) === absolute) throw new Error("Reference path must remain inside VOICE_REFERENCE_ROOT");
  return absolute;
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") throw new Error("text must be a string");
  const text = value.trim().replace(/\s+/gu, " ");
  if (!text || text.length > 500) throw new Error("text must contain 1–500 characters");
  return text;
}

function audioExtension(file: { path: string; url?: string }): string {
  const candidate = extname(file.path || file.url || "").toLowerCase();
  return candidate === ".mp3" ? ".mp3" : ".wav";
}

export class VoiceService {
  private readonly config: VoiceServiceConfig;
  private readonly gradio: GradioClient;
  private readonly completed = new Map<string, { path: string; contentType: "audio/wav" | "audio/mpeg" }>();
  private readonly cachedByFingerprint = new Map<string, VoiceSynthesisResult>();
  private generation = Promise.resolve();
  private weightsReady = false;

  constructor(config: VoiceServiceConfig, gradio: GradioClient) {
    this.config = config;
    this.gradio = gradio;
  }

  async health(): Promise<Record<string, unknown>> {
    await mkdir(this.config.outputDirectory, { recursive: true });
    return {
      status: "ok",
      weightsLocked: this.weightsReady,
      gptWeight: this.config.gptWeight,
      sovitsWeight: this.config.sovitsWeight,
      references: ["bright", "gentle", "soft"],
      naturalReferenceConfigured: Boolean(this.config.naturalReferenceSource?.trim()),
    };
  }

  async synthesize(input: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    const text = cleanText(input.text);
    const emotion = input.emotion ?? "neutral";
    const desiredPreset = input.preset ?? presetForEmotion(emotion);
    const { preset, fallbackFrom } = resolvePreset(desiredPreset, this.config.naturalReferenceSource);
    const sampling = samplingFor(text);
    const id = randomUUID();
    const fingerprint = this.requestFingerprint({ text, emotion, preset: desiredPreset, variation: Math.max(0, Math.floor(input.variation ?? 0)) });
    const result = new Promise<VoiceSynthesisResult>((resolveResult, reject) => {
      this.generation = this.generation.then(async () => {
        try {
          const cached = this.cachedByFingerprint.get(fingerprint);
          if (cached && this.completed.has(cached.id)) return resolveResult(cached);
          const generated = await this.synthesizeLocked(id, text, preset, fallbackFrom, sampling);
          this.cachedByFingerprint.set(fingerprint, generated);
          while (this.cachedByFingerprint.size > 30) this.cachedByFingerprint.delete(this.cachedByFingerprint.keys().next().value!);
          resolveResult(generated);
        }
        catch (error) { reject(error); }
      });
    });
    return result;
  }

  getAudio(id: string): { path: string; contentType: "audio/wav" | "audio/mpeg" } | null {
    return this.completed.get(id) ?? null;
  }

  private async synthesizeLocked(
    id: string,
    text: string,
    preset: ReturnType<typeof resolvePreset>["preset"],
    fallbackFrom: ReturnType<typeof resolvePreset>["fallbackFrom"],
    sampling: VoiceSynthesisResult["sampling"],
  ): Promise<VoiceSynthesisResult> {
    await mkdir(this.config.outputDirectory, { recursive: true });
    await this.ensureWeights();
    const referencePath = localPath(this.config.referenceRoot, preset.source);
    const referenceBytes = await readFile(referencePath);
    const uploaded = await this.gradio.uploadFile(referencePath, referenceBytes);
    // This order is the actual get_tts_wav API order exposed by the bundled
    // GPT-SoVITS 4.44 UI, not the visual order of its controls.
    const outputs = await this.gradio.call("get_tts_wav", [
      { path: uploaded.path, orig_name: uploaded.orig_name ?? "reference.wav", meta: { _type: "gradio.FileData" } },
      preset.promptText,
      "日文",
      text,
      "日文",
      "凑四句一切",
      sampling.topK,
      sampling.topP,
      sampling.temperature,
      false,
      1,
      false,
      null,
      8,
      false,
      0.3,
      false,
    ]);
    const file = outputs[0] as { path?: string; url?: string } | undefined;
    if (!file?.path) throw new Error("GPT-SoVITS did not return its generated local audio path");
    // GPT-SoVITS 4.44 incorrectly prefixes its generated URL with /call/, but
    // both processes live on this Windows host. Read the returned local path
    // directly rather than depending on that broken public URL.
    const generatedBytes = await readFile(file.path);
    const ext = audioExtension(file);
    const output = join(this.config.outputDirectory, `${id}${ext}`);
    await writeFile(output, generatedBytes, { flag: "wx" });
    const contentType = ext === ".mp3" ? "audio/mpeg" : "audio/wav";
    this.completed.set(id, { path: output, contentType });
    // A short bounded cache is enough for clients reconnecting through the relay.
    while (this.completed.size > 30) this.completed.delete(this.completed.keys().next().value!);
    return {
      id,
      preset: preset.id,
      fallbackFrom,
      sampling,
      // Relative by design. Core resolves it against its configured voice
      // endpoint, rather than baking a volatile Windows LAN IP into a reply.
      audioUrl: `/v1/audio/${id}`,
      contentType,
    };
  }

  private async ensureWeights(): Promise<void> {
    if (this.weightsReady) return;
    // GPT-SoVITS keeps weights in a mutable UI process.  Serializing every
    // generation lets us enforce the intended pair before the first request.
    await this.gradio.call("change_gpt_weights", [this.config.gptWeight]);
    await this.gradio.call("change_sovits_weights", [this.config.sovitsWeight, "日文", "日文"]);
    this.weightsReady = true;
  }

  hasValidToken(value: string | undefined): boolean {
    const received = Buffer.from(value ?? "");
    const expected = Buffer.from(this.config.apiToken);
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  requestFingerprint(input: VoiceSynthesisRequest): string {
    return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 12);
  }
}

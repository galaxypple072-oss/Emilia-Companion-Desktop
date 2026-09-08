import type { AgentConfig } from "./agent.ts";
import sharp from "sharp";

export interface VisionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  maxImageBytes: number;
}

export interface VisionImage {
  bytes: Uint8Array;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export interface VisionAdapter {
  analyze(image: VisionImage, prompt: string): Promise<string>;
}

export async function prepareVisionImage(image: VisionImage, maxBytes: number): Promise<VisionImage> {
  if (image.bytes.byteLength <= maxBytes) return image;
  const source = sharp(Buffer.from(image.bytes), { animated: false }).rotate();
  for (const quality of [82, 68, 52]) {
    const bytes = await source.clone()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (bytes.byteLength <= maxBytes) return { bytes, mediaType: "image/jpeg" };
  }
  const bytes = await source.clone()
    .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 45, mozjpeg: true })
    .toBuffer();
  if (bytes.byteLength > maxBytes) throw new Error(`Compressed image still exceeds the ${maxBytes}-byte vision limit`);
  return { bytes, mediaType: "image/jpeg" };
}

interface ChatCompletionResponse {
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null; reasoning_content?: string | null } }>;
  error?: { message?: string };
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected an integer between ${min} and ${max}, received ${value}`);
  }
  return parsed;
}

export function loadVisionConfig(
  agent: AgentConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): VisionConfig | null {
  if (!agent) return null;
  if (env.VISION_ENABLED?.trim().toLowerCase() === "false") return null;
  return {
    baseUrl: agent.baseUrl,
    apiKey: agent.apiKey,
    model: env.VISION_MODEL?.trim() || "deepseek-v4-flash-vision-exp",
    maxTokens: boundedInteger(env.VISION_MAX_TOKENS, 1200, 64, 8000),
    timeoutMs: boundedInteger(env.VISION_TIMEOUT_MS, 90_000, 1000, 300_000),
    maxImageBytes: boundedInteger(env.VISION_MAX_IMAGE_BYTES, 8 * 1024 * 1024, 64 * 1024, 20 * 1024 * 1024),
  };
}

export class DeepSeekVisionAdapter implements VisionAdapter {
  private readonly config: VisionConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: VisionConfig,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async analyze(image: VisionImage, prompt: string): Promise<string> {
    if (image.bytes.byteLength === 0) throw new Error("Image is empty");
    if (image.bytes.byteLength > this.config.maxImageBytes) {
      throw new Error(`Image exceeds the ${this.config.maxImageBytes}-byte limit`);
    }
    const dataUrl = `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`;
    const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt.trim() || "请描述这张图片。" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
        max_tokens: this.config.maxTokens,
        temperature: 0.2,
        thinking: { type: "disabled" },
        stream: false,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    const raw = await response.text();
    let payload: ChatCompletionResponse;
    try {
      payload = JSON.parse(raw) as ChatCompletionResponse;
    } catch {
      throw new Error(`Vision model returned non-JSON data (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`Vision request failed (HTTP ${response.status}): ${payload.error?.message ?? "unknown error"}`);
    }
    const result = payload.choices?.[0]?.message?.content?.trim();
    if (!result) {
      const choice = payload.choices?.[0];
      const reasoningLength = choice?.message?.reasoning_content?.length ?? 0;
      throw new Error(`Vision model returned an empty result (finish=${choice?.finish_reason ?? "unknown"}, reasoning_chars=${reasoningLength})`);
    }
    return result.slice(0, 6000);
  }
}

export function detectImageMediaType(bytes: Uint8Array): VisionImage["mediaType"] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 6) {
    const header = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

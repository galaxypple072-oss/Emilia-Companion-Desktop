import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "./env.ts";
import { GradioClient } from "./gradio-client.ts";
import { VoiceService, type VoiceServiceConfig } from "./voice-service.ts";
import type { VoiceSynthesisRequest } from "./types.ts";

loadEnvFile(resolve(process.cwd(), ".env.voice"));

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function port(value: string | undefined): number {
  const result = Number(value ?? 9873);
  if (!Number.isInteger(result) || result < 1024 || result > 65535) throw new Error("VOICE_SERVICE_PORT must be between 1024 and 65535");
  return result;
}

export function loadVoiceServiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceServiceConfig & { host: string; port: number; gradioUrl: string } {
  const host = env.VOICE_SERVICE_HOST?.trim() || "127.0.0.1";
  const servicePort = port(env.VOICE_SERVICE_PORT);
  return {
    host,
    port: servicePort,
    apiToken: required(env, "VOICE_SERVICE_TOKEN"),
    referenceRoot: required(env, "VOICE_REFERENCE_ROOT"),
    naturalReferenceSource: env.VOICE_NATURAL_REFERENCE_SOURCE?.trim() || undefined,
    outputDirectory: resolve(env.VOICE_OUTPUT_DIR?.trim() || "voice-output"),
    gptWeight: env.VOICE_GPT_WEIGHT?.trim() || "GPT_weights_v2Pro/EMILIA-LIM-R3-e50.ckpt",
    sovitsWeight: env.VOICE_SOVITS_WEIGHT?.trim() || "SoVITS_weights_v2Pro/EMILIA_LIM_R2_e8_s1624.pth",
    gradioUrl: env.VOICE_GRADIO_URL?.trim() || "http://127.0.0.1:9872",
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += part.length;
    if (total > 32 * 1024) throw new Error("Request body is too large");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(request: IncomingMessage, voice: VoiceService): boolean {
  const header = request.headers.authorization;
  return Boolean(header?.startsWith("Bearer ")) && voice.hasValidToken(header.slice("Bearer ".length));
}

const config = loadVoiceServiceConfig();
const voice = new VoiceService(config, new GradioClient(config.gradioUrl));
const server = createServer(async (request, response) => {
  try {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host || "localhost"}`);
    if (method === "GET" && url.pathname === "/healthz") return sendJson(response, 200, await voice.health());
    if (!authorized(request, voice)) return sendJson(response, 401, { error: "unauthorized" });
    if (method === "POST" && url.pathname === "/v1/synthesize") {
      const input = await body(request) as VoiceSynthesisRequest;
      const result = await voice.synthesize(input);
      return sendJson(response, 200, result);
    }
    const match = /^\/v1\/audio\/([0-9a-f-]{36})$/u.exec(url.pathname);
    if (method === "GET" && match) {
      const audio = voice.getAudio(match[1]);
      if (!audio) return sendJson(response, 404, { error: "not_found" });
      const data = await readFile(audio.path);
      response.writeHead(200, { "content-type": audio.contentType, "content-length": data.length, "cache-control": "private, max-age=120" });
      return response.end(data);
    }
    return sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[voice-service] ${error instanceof Error ? error.stack ?? message : message}`);
    return sendJson(response, 500, { error: "synthesis_failed", message });
  }
});

server.listen(config.port, config.host, () => console.log(`[voice-service] listening on http://${config.host}:${config.port}`));

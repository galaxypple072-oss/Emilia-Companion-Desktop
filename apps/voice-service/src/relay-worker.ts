import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import {
  createRuntimeAnnouncement,
  deriveRelayCredentials,
  openRelayPayload,
  parsePairingCode,
  sealRelayPayload,
} from "../../../packages/companion-relay-protocol/src/index.js";
import { loadDotEnv } from "../../qq-gateway/src/env.ts";
import { loadEnvFile } from "./env.ts";
import type { VoiceEmotion } from "./types.ts";

export interface RelayVoiceWorkerConfig {
  url: string;
  pairingCode: string;
  nodeId: string;
  name: string;
  voiceEndpoint: string;
  voiceToken: string;
}

interface RelayCredentials {
  deviceId: string;
  authToken: string;
  encryptionKey: CryptoKey;
}

type FetchLike = typeof fetch;

function localEndpoint(value: string): string {
  const url = new URL(value.replace(/\/$/u, ""));
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Voice Worker may only call a local voice service");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("VOICE_SERVICE_ENDPOINT is invalid");
  return url.toString().replace(/\/$/u, "");
}

function relayUrl(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) throw new Error("COMPANION_RELAY_URL is required for Voice Worker");
  const url = new URL(raw);
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new Error("COMPANION_RELAY_URL is invalid");
  url.hash = "";
  return url.toString();
}

export function loadRelayVoiceWorkerConfig(env: NodeJS.ProcessEnv = process.env): RelayVoiceWorkerConfig | null {
  if (env.EMILIA_VOICE_WORKER_ENABLED?.trim().toLowerCase() !== "true") return null;
  const pairingCode = env.COMPANION_RELAY_PAIRING_CODE?.trim() ?? "";
  parsePairingCode(pairingCode);
  const nodeId = env.EMILIA_VOICE_WORKER_ID?.trim() || "windows-voice";
  const name = env.EMILIA_VOICE_WORKER_NAME?.trim() || "Windows Voice";
  // Reuse the shared capability validator so an invalid local configuration is
  // rejected before it ever appears on the Relay.
  createRuntimeAnnouncement({ nodeId, name, capabilities: ["voice.synthesize", "host.health"] });
  const voiceToken = env.VOICE_SERVICE_TOKEN?.trim() ?? "";
  if (voiceToken.length < 24) throw new Error("VOICE_SERVICE_TOKEN is required for Voice Worker");
  return {
    url: relayUrl(env.COMPANION_RELAY_URL),
    pairingCode,
    nodeId,
    name,
    voiceEndpoint: localEndpoint(env.VOICE_SERVICE_ENDPOINT?.trim() || "http://127.0.0.1:9873"),
    voiceToken,
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function requestId(value: unknown): string {
  const id = typeof value === "string" ? value : "";
  if (!/^[A-Za-z0-9_-]{3,100}$/u.test(id)) throw new Error("Voice request ID is invalid");
  return id;
}

function voiceText(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 600) throw new Error("Voice request text is invalid");
  return text;
}

function voiceEmotion(value: unknown): VoiceEmotion {
  const emotion = typeof value === "string" ? value : "neutral";
  return ["neutral", "happy", "concerned", "think", "surprise", "shy", "angry", "sad"].includes(emotion)
    ? emotion as VoiceEmotion
    : "neutral";
}

/**
 * A resource worker owns only the local GPT-SoVITS bridge. It has no model or
 * chat credentials and never opens its HTTP service to the LAN: audio is sent
 * back to Core in bounded, encrypted Relay frames.
 */
export class RelayVoiceWorker {
  private readonly config: RelayVoiceWorkerConfig;
  private readonly fetchImpl: FetchLike;
  private credentials: RelayCredentials | null = null;
  private socket: WebSocket | null = null;
  private authenticated = false;
  private receiveChain: Promise<void> = Promise.resolve();
  private legacyRelay = false;

  constructor(config: RelayVoiceWorkerConfig, { fetchImpl = fetch }: { fetchImpl?: FetchLike } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.credentials = await deriveRelayCredentials(this.config.pairingCode) as RelayCredentials;
    let retry = 0;
    while (!signal.aborted) {
      try {
        await this.connectOnce(signal);
        retry = 0;
      } catch (error) {
        if (!signal.aborted) console.warn(`[voice-worker] disconnected: ${error instanceof Error ? error.message : String(error)}`);
        // The first public Relay release accepted only core/client roles. Fall
        // back once to its client transport; Core still validates the encrypted
        // runtime announcement before using this node for voice.
        if (!this.legacyRelay && /credentials are invalid|authentication failed/iu.test(error instanceof Error ? error.message : String(error))) {
          this.legacyRelay = true;
          console.log("[voice-worker] using legacy Relay transport compatibility");
        }
      }
      if (!signal.aborted) await delay(Math.min(30_000, 1000 * 2 ** Math.min(5, retry++)), signal);
    }
    this.socket?.close(1000, "Voice Worker stopping");
    this.socket = null;
    this.authenticated = false;
    await this.receiveChain;
  }

  private connectOnce(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.config.url, { maxPayload: 64 * 1024 });
      this.socket = socket;
      this.authenticated = false;
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (this.socket === socket) this.socket = null;
        this.authenticated = false;
        if (error) reject(error); else resolve();
      };
      const abort = (): void => { socket.close(1000, "Voice Worker stopping"); finish(); };
      signal.addEventListener("abort", abort, { once: true });
      socket.on("open", () => socket.send(JSON.stringify({
        type: "relay.auth", role: this.legacyRelay ? "client" : "worker", deviceId: this.credentials!.deviceId,
        peerId: this.config.nodeId, authToken: this.credentials!.authToken,
      })));
      socket.on("message", (raw) => {
        this.receiveChain = this.receiveChain
          .then(() => this.receive(socket, String(raw)))
          .catch((error) => console.warn(`[voice-worker] frame failed: ${error instanceof Error ? error.message : String(error)}`));
      });
      socket.on("error", (error) => finish(error));
      socket.on("close", (code, reason) => finish(signal.aborted ? undefined : new Error(`connection closed (${code}${reason.length ? `: ${String(reason)}` : ""})`)));
    });
  }

  private async receive(socket: WebSocket, raw: string): Promise<void> {
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (event.type === "relay.auth.ok") {
      if (socket !== this.socket) return;
      this.authenticated = true;
      await this.announce();
      console.log(`[voice-worker] connected node=${this.config.nodeId}`);
      return;
    }
    if (event.type === "relay.ping") {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "relay.pong", at: Date.now() }));
      return;
    }
    if (event.type === "relay.peer_online" && event.peerId === "core") return this.announce();
    if (event.type === "relay.auth.error") throw new Error(String(event.message || "Relay authentication failed"));
    if (event.type !== "relay.frame" || event.senderId !== "core") return;
    const payload = await openRelayPayload(this.credentials!, event) as Record<string, unknown>;
    if (payload.type === "voice.synthesize") await this.handleSynthesis(payload);
  }

  private async announce(): Promise<void> {
    await this.sendEncrypted("core", createRuntimeAnnouncement({
      nodeId: this.config.nodeId, name: this.config.name, capabilities: ["voice.synthesize", "host.health"],
    }));
  }

  private async handleSynthesis(payload: Record<string, unknown>): Promise<void> {
    let id = "";
    try {
      id = requestId(payload.requestId);
      const text = voiceText(payload.text);
      const emotion = voiceEmotion(payload.emotion);
      const voice = await this.synthesize(text, emotion);
      const size = 4 * 1024;
      const total = Math.ceil(voice.bytes.length / size);
      await this.sendEncrypted("core", { type: "voice.synthesize.begin", requestId: id, mimeType: voice.mimeType, total });
      for (let index = 0; index < total; index += 1) {
        const bytes = voice.bytes.subarray(index * size, Math.min(voice.bytes.length, (index + 1) * size));
        await this.sendEncrypted("core", { type: "voice.synthesize.chunk", requestId: id, index, data: Buffer.from(bytes).toString("base64") });
      }
      await this.sendEncrypted("core", { type: "voice.synthesize.end", requestId: id });
    } catch (error) {
      if (id) await this.sendEncrypted("core", { type: "voice.synthesize.error", requestId: id, message: error instanceof Error ? error.message.slice(0, 500) : "Voice synthesis failed" });
    }
  }

  private async synthesize(text: string, emotion: VoiceEmotion): Promise<{ mimeType: "audio/wav" | "audio/mpeg"; bytes: Uint8Array }> {
    const headers = { authorization: `Bearer ${this.config.voiceToken}`, "content-type": "application/json" };
    const result = await this.fetchImpl(`${this.config.voiceEndpoint}/v1/synthesize`, {
      method: "POST", headers, body: JSON.stringify({ text, emotion }), signal: AbortSignal.timeout(180_000),
    });
    if (!result.ok) throw new Error(`Local voice service failed (${result.status})`);
    const payload = await result.json() as { audioUrl?: string; contentType?: string };
    if (!payload.audioUrl?.startsWith("/v1/audio/")) throw new Error("Local voice service returned an invalid audio URL");
    const audio = await this.fetchImpl(`${this.config.voiceEndpoint}${payload.audioUrl}`, { headers: { authorization: `Bearer ${this.config.voiceToken}` }, signal: AbortSignal.timeout(60_000) });
    if (!audio.ok) throw new Error(`Local voice audio download failed (${audio.status})`);
    const bytes = new Uint8Array(await audio.arrayBuffer());
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error("Local voice audio size is invalid");
    return { mimeType: payload.contentType === "audio/mpeg" ? "audio/mpeg" : "audio/wav", bytes };
  }

  private async sendEncrypted(recipientId: string, payload: Record<string, unknown>): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.authenticated || !this.credentials) return;
    const frame = await sealRelayPayload(this.credentials, { senderId: this.config.nodeId, recipientId, payload });
    if (socket === this.socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }
}

async function main(): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  loadDotEnv(resolve(projectRoot, ".env"));
  loadEnvFile(process.env.EMILIA_VOICE_ENV_PATH?.trim() || resolve(process.cwd(), ".env.voice"));
  const config = loadRelayVoiceWorkerConfig();
  if (!config) return;
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await new RelayVoiceWorker(config).run(controller.signal);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[voice-worker] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

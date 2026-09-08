import { timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { DeviceControlRouter } from "./device-control-router.ts";

export const COMPANION_BRIDGE_PROTOCOL = 1;

export interface CompanionBridgeConfig {
  host: string;
  port: number;
  token: string;
  serverName: string;
}

export interface CompanionChatRequest {
  requestId: string;
  clientId: string;
  clientName: string;
  text: string;
}

export interface CompanionChatResponse {
  chunks: string[];
  emotion: CompanionEmotion;
  intensity: number;
  motion: string;
  voice?: { id: string; mimeType: string; bytes: Uint8Array } | null;
}

export interface CompanionFileSendRequest {
  requestId: string;
  clientId: string;
  clientName: string;
  path: string;
}

export interface CompanionFileSendResponse {
  name: string;
  size: number;
  sha256: string;
  externalId: string | null;
}

export interface CompanionTaskRequest {
  requestId: string;
  action: "list" | "complete" | "cancel";
  taskId?: string;
}

export interface CompanionTaskResponse {
  tasks: Array<{
    id: string; title: string; notes: string | null; status: string;
    priority: string; dueAt: number | null; createdAt: number; updatedAt: number;
  }>;
}

export type CompanionEmotion = "neutral" | "happy" | "concerned" | "think" | "surprise" | "shy" | "angry" | "sad";

interface ClientState {
  authenticated: boolean;
  clientId: string;
  clientName: string;
  authTimer: NodeJS.Timeout;
  connectionKey: string;
}

function boundedPort(value: string | undefined): number {
  const port = Number(value ?? 8765);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("COMPANION_BRIDGE_PORT must be between 1024 and 65535");
  return port;
}

export function loadCompanionBridgeConfig(env: NodeJS.ProcessEnv = process.env): CompanionBridgeConfig | null {
  if (env.COMPANION_BRIDGE_ENABLED?.trim().toLowerCase() !== "true") return null;
  const token = env.COMPANION_BRIDGE_TOKEN?.trim() ?? "";
  if (token.length < 24) throw new Error("COMPANION_BRIDGE_TOKEN must contain at least 24 characters");
  return {
    host: env.COMPANION_BRIDGE_HOST?.trim() || "0.0.0.0",
    port: boundedPort(env.COMPANION_BRIDGE_PORT),
    token,
    serverName: env.COMPANION_BRIDGE_NAME?.trim().slice(0, 60) || "Emilia Core",
  };
}

export function inferCompanionEmotion(text: string): CompanionEmotion {
  if (/(?:难过|伤心|委屈|呜|抱抱|心疼)/u.test(text)) return "sad";
  if (/(?:生气|可恶|讨厌|笨蛋|哼)/u.test(text)) return "angry";
  if (/(?:诶|欸|居然|真的假的|！|!)/u.test(text)) return "surprise";
  if (/(?:害羞|脸红|唔|才没有|♡)/u.test(text)) return "shy";
  if (/(?:想想|等等|让我看|唔姆|大概|也许)/u.test(text)) return "think";
  if (/(?:哈哈|嘿嘿|开心|太好|好耶|☺|～|~)/u.test(text)) return "happy";
  return "neutral";
}

function sameToken(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cleanIdentity(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[^\p{L}\p{N}_. -]/gu, "").trim().slice(0, 60);
  return normalized || fallback;
}

export class CompanionBridgeServer {
  private readonly config: CompanionBridgeConfig;
  private readonly onChat: (request: CompanionChatRequest) => Promise<CompanionChatResponse>;
  private readonly devices: DeviceControlRouter | null;
  private readonly onFileSend: ((request: CompanionFileSendRequest) => Promise<CompanionFileSendResponse>) | null;
  private readonly onTask: ((request: CompanionTaskRequest) => Promise<CompanionTaskResponse>) | null;
  private readonly onVoice: ((response: CompanionChatResponse) => Promise<NonNullable<CompanionChatResponse["voice"]> | null>) | null;
  private server: WebSocketServer | null = null;
  private readonly clients = new Map<WebSocket, ClientState>();

  constructor(config: CompanionBridgeConfig, onChat: (request: CompanionChatRequest) => Promise<CompanionChatResponse>, devices: DeviceControlRouter | null = null, onFileSend: ((request: CompanionFileSendRequest) => Promise<CompanionFileSendResponse>) | null = null, onTask: ((request: CompanionTaskRequest) => Promise<CompanionTaskResponse>) | null = null, onVoice: ((response: CompanionChatResponse) => Promise<NonNullable<CompanionChatResponse["voice"]> | null>) | null = null) {
    this.config = config;
    this.onChat = onChat;
    this.devices = devices;
    this.onFileSend = onFileSend;
    this.onTask = onTask;
    this.onVoice = onVoice;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.server) throw new Error("Companion Bridge is already running");
    const server = new WebSocketServer({ host: this.config.host, port: this.config.port, maxPayload: 64 * 1024 });
    this.server = server;
    server.on("connection", (socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        console.log(`[companion-bridge] listening on ws://${this.config.host}:${this.config.port}`);
        resolve();
      };
      const onError = (error: Error): void => reject(error);
      server.once("listening", onListening);
      server.once("error", onError);
    });
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    for (const socket of this.clients.keys()) socket.close(1001, "Server shutting down");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.clients.clear();
    this.server = null;
  }

  broadcast(event: Record<string, unknown>): void {
    for (const [socket, state] of this.clients) {
      if (state.authenticated && socket.readyState === WebSocket.OPEN) this.send(socket, event);
    }
  }

  private accept(socket: WebSocket): void {
    const authTimer = setTimeout(() => socket.close(4001, "Authentication timeout"), 5000);
    const state: ClientState = { authenticated: false, clientId: "", clientName: "", authTimer, connectionKey: "" };
    this.clients.set(socket, state);
    this.send(socket, { type: "hello", protocol: COMPANION_BRIDGE_PROTOCOL, serverName: this.config.serverName });
    socket.on("close", () => {
      clearTimeout(authTimer);
      if (state.connectionKey) this.devices?.unregister(state.connectionKey);
      this.clients.delete(socket);
    });
    socket.on("error", () => undefined);
    socket.on("message", (raw) => void this.receive(socket, state, String(raw)));
  }

  private async receive(socket: WebSocket, state: ClientState, raw: string): Promise<void> {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return this.send(socket, { type: "error", code: "invalid_json", message: "消息格式不正确" });
    }
    if (!state.authenticated) {
      if (event.type !== "auth" || typeof event.token !== "string" || !sameToken(event.token, this.config.token)) {
        this.send(socket, { type: "auth.error", message: "访问 Token 不正确" });
        return socket.close(4003, "Authentication failed");
      }
      const client = event.client && typeof event.client === "object" ? event.client as Record<string, unknown> : {};
      state.authenticated = true;
      clearTimeout(state.authTimer);
      state.clientId = cleanIdentity(client.id, "desktop");
      state.clientName = cleanIdentity(client.name, "Desktop");
      state.connectionKey = `direct:${state.clientId}`;
      this.send(socket, { type: "auth.ok", clientId: state.clientId, serverName: this.config.serverName });
      return;
    }
    if (event.type === "ping") return this.send(socket, { type: "pong", at: Date.now() });
    if (event.type === "device.announce" && this.devices) {
      try {
        const device = this.devices.register(state.connectionKey, state.clientId, "direct", event, async (payload) => this.send(socket, payload));
        console.log(`[device-control] registered id=${device.id} name=${device.name} transport=direct capabilities=${device.capabilities.filter((item) => item.granted).length}`);
        return this.send(socket, { type: "device.announce.ack", deviceId: device.id });
      } catch (error) {
        return this.send(socket, { type: "error", code: "invalid_device", message: error instanceof Error ? error.message : String(error) });
      }
    }
    if ((event.type === "device.result" || event.type === "device.result.chunk") && this.devices?.handleResult(state.connectionKey, event)) return;
    if (event.type === "tasks.list" || event.type === "tasks.complete" || event.type === "tasks.cancel") {
      void this.handleTask(socket, event);
      return;
    }
    if (event.type === "file.send_qq") {
      const requestId = typeof event.requestId === "string" ? event.requestId.slice(0, 100) : "";
      const path = typeof event.path === "string" ? event.path.trim().slice(0, 2000) : "";
      if (!requestId || !path) return this.send(socket, { type: "file.send_qq.result", requestId, ok: false, error: "请选择要发送的文件" });
      if (!this.onFileSend) return this.send(socket, { type: "file.send_qq.result", requestId, ok: false, error: "Core 尚未启用 QQ 文件发送" });
      void this.handleFileSend(socket, state, { requestId, clientId: state.clientId, clientName: state.clientName, path });
      return;
    }
    if (event.type !== "chat.send") return this.send(socket, { type: "error", code: "unknown_event", message: "不支持的消息类型" });
    const requestId = typeof event.requestId === "string" ? event.requestId.slice(0, 100) : "";
    const text = typeof event.text === "string" ? event.text.trim().slice(0, 4000) : "";
    if (!requestId || !text) return this.send(socket, { type: "error", code: "invalid_chat", message: "消息不能为空" });
    this.send(socket, { type: "assistant.state", requestId, state: "thinking" });
    try {
      const response = await this.onChat({ requestId, clientId: state.clientId, clientName: state.clientName, text });
      response.chunks.forEach((chunk, index) => this.send(socket, {
        type: "assistant.reply", requestId, text: chunk, index, total: response.chunks.length,
        emotion: response.emotion, intensity: response.intensity, motion: response.motion,
      }));
      this.send(socket, { type: "assistant.state", requestId, state: "idle" });
      if (this.onVoice) void this.onVoice(response).then((voice) => { if (voice) this.sendVoice(socket, voice); }).catch((error) => console.warn(`[voice] background synthesis failed: ${error instanceof Error ? error.message : String(error)}`));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[companion-bridge] chat failed: ${detail}`);
      this.send(socket, { type: "assistant.state", requestId, state: "error", message: "刚才卡住了……这条没处理完" });
    }
  }

  private async handleTask(socket: WebSocket, event: Record<string, unknown>): Promise<void> {
    const requestId = typeof event.requestId === "string" ? event.requestId.slice(0, 100) : "";
    const action = String(event.type).replace("tasks.", "") as CompanionTaskRequest["action"];
    const taskId = typeof event.taskId === "string" ? event.taskId.slice(0, 80) : undefined;
    if (!requestId || !this.onTask) return this.send(socket, { type: "tasks.result", requestId, ok: false, error: "Core 尚未启用任务管理" });
    try {
      const result = await this.onTask({ requestId, action, taskId });
      this.send(socket, { type: "tasks.result", requestId, ok: true, ...result });
    } catch (error) {
      this.send(socket, { type: "tasks.result", requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async handleFileSend(socket: WebSocket, state: ClientState, request: CompanionFileSendRequest): Promise<void> {
    this.send(socket, { type: "file.send_qq.state", requestId: request.requestId, state: "transferring" });
    try {
      const result = await this.onFileSend!(request);
      this.send(socket, { type: "file.send_qq.result", requestId: request.requestId, ok: true, ...result });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[companion-bridge] file send failed client=${state.clientId}: ${detail}`);
      this.send(socket, { type: "file.send_qq.result", requestId: request.requestId, ok: false, error: detail });
    }
  }

  private send(socket: WebSocket, event: Record<string, unknown>): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }

  private sendVoice(socket: WebSocket, voice: NonNullable<CompanionChatResponse["voice"]>): void {
    const size = 18 * 1024;
    const total = Math.ceil(voice.bytes.length / size);
    this.send(socket, { type: "voice.audio.begin", id: voice.id, mimeType: voice.mimeType, total });
    for (let index = 0; index < total; index += 1) {
      const bytes = voice.bytes.subarray(index * size, Math.min(voice.bytes.length, (index + 1) * size));
      this.send(socket, { type: "voice.audio.chunk", id: voice.id, index, data: Buffer.from(bytes).toString("base64") });
    }
    this.send(socket, { type: "voice.audio.end", id: voice.id });
  }
}

import { WebSocket } from "ws";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveRelayCredentials,
  openRelayPayload,
  parsePairingCode,
  sealRelayPayload,
} from "../../../packages/companion-relay-protocol/src/index.js";
import type { CompanionChatRequest, CompanionChatResponse, CompanionFileSendRequest, CompanionFileSendResponse, CompanionTaskRequest, CompanionTaskResponse } from "./companion-bridge.ts";
import type { CompanionEndpoint } from "./companion-endpoint.ts";
import type { DeviceControlRouter } from "./device-control-router.ts";
import type { RuntimeNodeRegistry } from "./runtime-node-registry.ts";
import type { GeneratedVoice, VoiceSynthesizer } from "./voice-client.ts";
import type { QqClient } from "./qq-client.ts";

interface RelayConfig {
  url: string;
  pairingCode: string;
  serverName: string;
}

interface RelayCredentials {
  deviceId: string;
  authToken: string;
  encryptionKey: CryptoKey;
}

interface PendingVoiceRequest {
  workerId: string;
  total: number | null;
  mimeType: string | null;
  chunks: Map<number, Buffer>;
  timer: NodeJS.Timeout;
  resolve: (voice: GeneratedVoice) => void;
  reject: (error: Error) => void;
}

interface PendingQqRequest {
  workerId: string;
  timer: NodeJS.Timeout;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

interface PendingQqImageRequest extends PendingQqRequest {
  total: number | null;
  chunks: Map<number, Buffer>;
  metadata: { url?: string; file_size?: number; file_name?: string };
}

const QQ_TRANSFER_CHUNK_BYTES = 4 * 1024;
const MAX_QQ_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_QQ_FILE_BYTES = 20 * 1024 * 1024;

function relayUrl(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) throw new Error("COMPANION_RELAY_URL is required when relay mode is enabled");
  const parsed = new URL(raw);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new Error("COMPANION_RELAY_URL must use ws:// or wss://");
  return parsed.toString();
}

export function loadCompanionRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig | null {
  if (env.COMPANION_RELAY_ENABLED?.trim().toLowerCase() !== "true") return null;
  const pairingCode = env.COMPANION_RELAY_PAIRING_CODE?.trim() ?? "";
  parsePairingCode(pairingCode);
  return {
    url: relayUrl(env.COMPANION_RELAY_URL),
    pairingCode,
    serverName: env.COMPANION_BRIDGE_NAME?.trim().slice(0, 60) || "Emilia Core",
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export class RelayCompanionEndpoint implements CompanionEndpoint, VoiceSynthesizer, QqClient {
  private readonly config: RelayConfig;
  private readonly onChat: (request: CompanionChatRequest) => Promise<CompanionChatResponse>;
  private readonly devices: DeviceControlRouter | null;
  private readonly onFileSend: ((request: CompanionFileSendRequest) => Promise<CompanionFileSendResponse>) | null;
  private readonly onTask: ((request: CompanionTaskRequest) => Promise<CompanionTaskResponse>) | null;
  private readonly onVoice: ((response: CompanionChatResponse) => Promise<NonNullable<CompanionChatResponse["voice"]> | null>) | null;
  private readonly runtimeNodes: RuntimeNodeRegistry | null;
  private readonly onQqInbound: ((event: unknown) => void) | null;
  private socket: WebSocket | null = null;
  private credentials: RelayCredentials | null = null;
  private authenticated = false;
  private receiveChain: Promise<void> = Promise.resolve();
  private readonly seenMessageIds = new Set<string>();
  private readonly peerRoles = new Map<string, "client" | "worker">();
  private readonly pendingVoice = new Map<string, PendingVoiceRequest>();
  private readonly pendingQq = new Map<string, PendingQqRequest>();
  private readonly pendingQqImages = new Map<string, PendingQqImageRequest>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;

  constructor(config: RelayConfig, onChat: (request: CompanionChatRequest) => Promise<CompanionChatResponse>, devices: DeviceControlRouter | null = null, onFileSend: ((request: CompanionFileSendRequest) => Promise<CompanionFileSendResponse>) | null = null, onTask: ((request: CompanionTaskRequest) => Promise<CompanionTaskResponse>) | null = null, onVoice: ((response: CompanionChatResponse) => Promise<NonNullable<CompanionChatResponse["voice"]> | null>) | null = null, runtimeNodes: RuntimeNodeRegistry | null = null, onQqInbound: ((event: unknown) => void) | null = null) {
    this.config = config;
    this.onChat = onChat;
    this.devices = devices;
    this.onFileSend = onFileSend;
    this.onTask = onTask;
    this.onVoice = onVoice;
    this.runtimeNodes = runtimeNodes;
    this.onQqInbound = onQqInbound;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.credentials = await deriveRelayCredentials(this.config.pairingCode) as RelayCredentials;
    let retry = 0;
    while (!signal.aborted) {
      try {
        await this.connectOnce(signal);
        retry = 0;
      } catch (error) {
        if (signal.aborted) break;
        console.warn(`[companion-relay] disconnected: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!signal.aborted) await delay(Math.min(30_000, 1000 * 2 ** Math.min(5, retry++)), signal);
    }
    this.socket?.close(1000, "Core shutting down");
    this.stopHeartbeat();
    this.socket = null;
    this.authenticated = false;
    this.devices?.unregisterTransport("relay");
    this.rejectVoiceRequests(undefined, new Error("Relay Core stopped"));
    this.rejectQqRequests(undefined, new Error("Relay Core stopped"));
    await this.receiveChain;
  }

  broadcast(event: Record<string, unknown>): void {
    void this.sendEncrypted("*", event);
  }

  async synthesizeIfJapanese(text: string, emotion: CompanionChatResponse["emotion"]): Promise<GeneratedVoice | null> {
    const worker = this.runtimeNodes?.findByCapability("voice.synthesize");
    if (!worker) return null;
    const requestId = crypto.randomUUID();
    const response = new Promise<GeneratedVoice>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingVoice.delete(requestId);
        reject(new Error(`Voice worker ${worker.id} timed out`));
      }, 180_000);
      this.pendingVoice.set(requestId, { workerId: worker.id, total: null, mimeType: null, chunks: new Map(), timer, resolve, reject });
    });
    await this.sendEncrypted(worker.id, { type: "voice.synthesize", requestId, text, emotion });
    return response;
  }

  async sendPrivateMessage(recipientId: string, text: string): Promise<Record<string, unknown>> {
    const worker = this.runtimeNodes?.findByCapability("qq.send");
    if (!worker) throw new Error("No QQ Worker is connected");
    const { requestId, result } = this.createQqRequest(worker.id, 30_000);
    await this.sendEncrypted(worker.id, { type: "qq.send.text", requestId, recipientId, text });
    return result;
  }
  async sendPrivateImage(recipientId: string, file: string, options: { summary?: string; subType?: number } = {}): Promise<Record<string, unknown>> {
    return this.sendQqAttachment("image", recipientId, await this.readQqAttachment(file, MAX_QQ_IMAGE_BYTES, "Image"), options);
  }

  async sendPrivateFile(recipientId: string, file: string, name: string): Promise<Record<string, unknown>> {
    const displayName = name.trim();
    if (!displayName || displayName.length > 255 || /[\\/:*?"<>|\r\n]/u.test(displayName)) throw new Error("File display name is invalid");
    return this.sendQqAttachment("file", recipientId, await this.readQqAttachment(file, MAX_QQ_FILE_BYTES, "File"), { name: displayName });
  }

  async getImage(file: string): Promise<{ file?: string; url?: string; file_size?: number; file_name?: string; bytes?: Buffer }> {
    const worker = this.runtimeNodes?.findByCapability("qq.send");
    const imageId = file.trim();
    if (!worker) throw new Error("No QQ Worker is connected");
    if (!imageId || imageId.length > 2000) throw new Error("Invalid OneBot image file identifier");
    const requestId = crypto.randomUUID();
    const result = new Promise<{ file?: string; url?: string; file_size?: number; file_name?: string; bytes?: Buffer }>((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingQqImages.delete(requestId); reject(new Error("QQ Worker image lookup timed out")); }, 180_000);
      this.pendingQqImages.set(requestId, { workerId: worker.id, timer, resolve, reject, total: null, chunks: new Map(), metadata: {} });
    });
    await this.sendEncrypted(worker.id, { type: "qq.get_image", requestId, file: imageId });
    return result;
  }

  private createQqRequest(workerId: string, timeoutMs: number): { requestId: string; result: Promise<Record<string, unknown>> } {
    const requestId = crypto.randomUUID();
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingQq.delete(requestId); reject(new Error("QQ Worker timed out")); }, timeoutMs);
      this.pendingQq.set(requestId, { workerId, timer, resolve, reject });
    });
    return { requestId, result };
  }

  private async readQqAttachment(file: string, maximumBytes: number, label: string): Promise<{ bytes: Buffer; name: string }> {
    const supplied = file.trim();
    if (!supplied || supplied.length > 2000) throw new Error(`${label} path is invalid`);
    const path = supplied.startsWith("file:") ? fileURLToPath(supplied) : supplied;
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`${label} path is not a file`);
    if (metadata.size < 1 || metadata.size > maximumBytes) throw new Error(`${label} exceeds the ${Math.floor(maximumBytes / 1024 / 1024)}MB transfer limit`);
    return { bytes: await readFile(path), name: basename(path) || "attachment" };
  }

  private async sendQqAttachment(kind: "image" | "file", recipientId: string, attachment: { bytes: Buffer; name: string }, options: { summary?: string; subType?: number; name?: string }): Promise<Record<string, unknown>> {
    const worker = this.runtimeNodes?.findByCapability("qq.send");
    if (!worker) throw new Error("No QQ Worker is connected");
    const { requestId, result } = this.createQqRequest(worker.id, 180_000);
    const total = Math.ceil(attachment.bytes.length / QQ_TRANSFER_CHUNK_BYTES);
    await this.sendEncrypted(worker.id, {
      type: `qq.send.${kind}.begin`, requestId, recipientId, total, size: attachment.bytes.length,
      name: options.name ?? attachment.name,
      ...(typeof options.summary === "string" ? { summary: options.summary.slice(0, 200) } : {}),
      ...(Number.isInteger(options.subType) ? { subType: options.subType } : {}),
    });
    for (let index = 0; index < total; index += 1) {
      const bytes = attachment.bytes.subarray(index * QQ_TRANSFER_CHUNK_BYTES, Math.min(attachment.bytes.length, (index + 1) * QQ_TRANSFER_CHUNK_BYTES));
      await this.sendEncrypted(worker.id, { type: `qq.send.${kind}.chunk`, requestId, index, data: bytes.toString("base64") });
    }
    await this.sendEncrypted(worker.id, { type: `qq.send.${kind}.end`, requestId });
    return result;
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
        if (this.socket === socket) {
          this.socket = null;
          this.peerRoles.clear();
          this.runtimeNodes?.clear();
          this.rejectVoiceRequests(undefined, new Error("Relay connection closed"));
          this.rejectQqRequests(undefined, new Error("Relay connection closed"));
        }
        this.stopHeartbeat();
        this.authenticated = false;
        if (error) reject(error);
        else resolve();
      };
      const abort = (): void => {
        socket.close(1000, "Core shutting down");
        finish();
      };
      signal.addEventListener("abort", abort, { once: true });
      socket.on("open", () => {
        socket.send(JSON.stringify({
          type: "relay.auth",
          role: "core",
          deviceId: this.credentials!.deviceId,
          peerId: "core",
          authToken: this.credentials!.authToken,
        }));
      });
      socket.on("message", (raw) => {
        this.receiveChain = this.receiveChain
          .then(() => this.receive(socket, String(raw)))
          .catch((error) => console.error(`[companion-relay] frame failed: ${error instanceof Error ? error.message : String(error)}`));
      });
      socket.on("error", (error) => finish(error));
      socket.on("close", (code, reason) => {
        if (signal.aborted) finish();
        else finish(new Error(`connection closed (${code}${reason.length ? `: ${String(reason)}` : ""})`));
      });
    });
  }

  private async receive(socket: WebSocket, raw: string): Promise<void> {
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (event.type === "relay.auth.ok") {
      if (socket !== this.socket) return;
      this.authenticated = true;
      this.startHeartbeat(socket);
      console.log(`[companion-relay] core connected device=${this.credentials!.deviceId}`);
      return;
    }
    if (event.type === "relay.pong") {
      this.lastPongAt = Date.now();
      return;
    }
    if (event.type === "relay.auth.error") throw new Error(String(event.message || "relay authentication failed"));
    if (event.type === "relay.error") {
      console.warn(`[companion-relay] relay rejected frame code=${String(event.code || "unknown")}`);
      return;
    }
    if (event.type === "relay.peer_online" && typeof event.peerId === "string") {
      const role = event.role === "worker" ? "worker" : "client";
      this.peerRoles.set(event.peerId, role);
      console.log(`[companion-relay] peer online id=${event.peerId} role=${role}`);
      return;
    }
    if (event.type === "relay.peer_offline" && typeof event.peerId === "string") {
      this.devices?.unregister(`relay:${event.peerId}`);
      this.runtimeNodes?.unregister(event.peerId);
      this.peerRoles.delete(event.peerId);
      this.rejectVoiceRequests(event.peerId, new Error(`Voice worker ${event.peerId} disconnected`));
      this.rejectQqRequests(event.peerId, new Error(`QQ worker ${event.peerId} disconnected`));
      return;
    }
    if (event.type !== "relay.frame" || event.recipientId !== "core" || typeof event.messageId !== "string") return;
    if (this.seenMessageIds.has(event.messageId)) return;
    this.seenMessageIds.add(event.messageId);
    if (this.seenMessageIds.size > 2048) this.seenMessageIds.delete(this.seenMessageIds.values().next().value!);
    const payload = await openRelayPayload(this.credentials!, event) as Record<string, unknown>;
    const clientId = typeof event.senderId === "string" ? event.senderId : "desktop";
    if (payload.type === "ping") return this.sendEncrypted(clientId, { type: "pong", at: Date.now() });
    if (this.handleVoiceWorkerResult(clientId, payload)) return;
    if (this.handleQqWorkerEvent(clientId, payload)) return;
    if (payload.type === "runtime.announce") {
      // Older deployed Relays know only core/client. A worker can safely use a
      // client transport as a compatibility envelope because its capability
      // declaration remains encrypted and is still validated by Core.
      if (!this.runtimeNodes) {
        return this.sendEncrypted(clientId, { type: "runtime.announce.ack", ok: false, error: "Runtime capabilities are unavailable" });
      }
      // Some pre-worker Relay deployments forward an encrypted client frame
      // but omit the peer_online replay after a Core restart. The Relay has
      // already authenticated the frame sender and AES-GCM binds that sender
      // ID, so retain it as a legacy client transport for this announcement.
      if (!this.peerRoles.has(clientId)) this.peerRoles.set(clientId, "client");
      try {
        const node = this.runtimeNodes.register(clientId, payload);
        console.log(`[runtime] worker registered id=${node.id} capabilities=${node.capabilities.join(",")}`);
        return this.sendEncrypted(clientId, { type: "runtime.announce.ack", ok: true, nodeId: node.id });
      } catch (error) {
        return this.sendEncrypted(clientId, { type: "runtime.announce.ack", ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const connectionKey = `relay:${clientId}`;
    if (payload.type === "device.announce" && this.devices) {
      try {
        const device = this.devices.register(connectionKey, clientId, "relay", payload, async (outbound) => this.sendEncrypted(clientId, outbound));
        console.log(`[device-control] registered id=${device.id} name=${device.name} transport=relay capabilities=${device.capabilities.filter((item) => item.granted).length}`);
        return this.sendEncrypted(clientId, { type: "device.announce.ack", deviceId: device.id });
      } catch (error) {
        return this.sendEncrypted(clientId, { type: "error", code: "invalid_device", message: error instanceof Error ? error.message : String(error) });
      }
    }
    if ((payload.type === "device.result" || payload.type === "device.result.chunk") && this.devices?.handleResult(connectionKey, payload)) return;
    if (payload.type === "tasks.list" || payload.type === "tasks.complete" || payload.type === "tasks.cancel") {
      void this.handleTask(clientId, payload);
      return;
    }
    if (payload.type === "file.send_qq") {
      const requestId = typeof payload.requestId === "string" ? payload.requestId.slice(0, 100) : "";
      const path = typeof payload.path === "string" ? payload.path.trim().slice(0, 2000) : "";
      const clientName = typeof payload.clientName === "string" ? payload.clientName.slice(0, 60) : clientId;
      if (!requestId || !path) return this.sendEncrypted(clientId, { type: "file.send_qq.result", requestId, ok: false, error: "请选择要发送的文件" });
      if (!this.onFileSend) return this.sendEncrypted(clientId, { type: "file.send_qq.result", requestId, ok: false, error: "Core 尚未启用 QQ 文件发送" });
      void this.handleFileSend(clientId, { requestId, clientId, clientName, path });
      return;
    }
    if (payload.type !== "chat.send") return;
    void this.handleChat(clientId, payload);
  }

  private async handleTask(clientId: string, payload: Record<string, unknown>): Promise<void> {
    const requestId = typeof payload.requestId === "string" ? payload.requestId.slice(0, 100) : "";
    const action = String(payload.type).replace("tasks.", "") as CompanionTaskRequest["action"];
    const taskId = typeof payload.taskId === "string" ? payload.taskId.slice(0, 80) : undefined;
    if (!requestId || !this.onTask) return this.sendEncrypted(clientId, { type: "tasks.result", requestId, ok: false, error: "Core 尚未启用任务管理" });
    try {
      const result = await this.onTask({ requestId, action, taskId });
      await this.sendEncrypted(clientId, { type: "tasks.result", requestId, ok: true, ...result });
    } catch (error) {
      await this.sendEncrypted(clientId, { type: "tasks.result", requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async handleFileSend(clientId: string, request: CompanionFileSendRequest): Promise<void> {
    await this.sendEncrypted(clientId, { type: "file.send_qq.state", requestId: request.requestId, state: "transferring" });
    try {
      const result = await this.onFileSend!(request);
      await this.sendEncrypted(clientId, { type: "file.send_qq.result", requestId: request.requestId, ok: true, ...result });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[companion-relay] file send failed client=${clientId}: ${detail}`);
      await this.sendEncrypted(clientId, { type: "file.send_qq.result", requestId: request.requestId, ok: false, error: detail });
    }
  }

  private async handleChat(clientId: string, payload: Record<string, unknown>): Promise<void> {
    const requestId = typeof payload.requestId === "string" ? payload.requestId.slice(0, 100) : "";
    const text = typeof payload.text === "string" ? payload.text.trim().slice(0, 4000) : "";
    const clientName = typeof payload.clientName === "string" ? payload.clientName.slice(0, 60) : clientId;
    if (!requestId || !text) return this.sendEncrypted(clientId, { type: "error", code: "invalid_chat", message: "消息不能为空" });
    await this.sendEncrypted(clientId, { type: "assistant.state", requestId, state: "thinking" });
    try {
      const response = await this.onChat({ requestId, clientId, clientName, text });
      for (const [index, chunk] of response.chunks.entries()) {
        await this.sendEncrypted(clientId, {
          type: "assistant.reply", requestId, text: chunk, index, total: response.chunks.length,
          emotion: response.emotion, intensity: response.intensity, motion: response.motion,
        });
      }
      await this.sendEncrypted(clientId, { type: "assistant.state", requestId, state: "idle" });
      if (this.onVoice) void this.onVoice(response).then((voice) => voice ? this.sendVoice(clientId, voice) : undefined).catch((error) => console.warn(`[voice] background synthesis failed: ${error instanceof Error ? error.message : String(error)}`));
    } catch (error) {
      console.error(`[companion-relay] chat failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.sendEncrypted(clientId, { type: "assistant.state", requestId, state: "error", message: "刚才卡住了……这条没处理完" });
    }
  }

  private async sendEncrypted(recipientId: string, payload: Record<string, unknown>): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.authenticated || !this.credentials) return;
    const frame = await sealRelayPayload(this.credentials, { senderId: "core", recipientId, payload });
    if (socket === this.socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  private handleVoiceWorkerResult(workerId: string, payload: Record<string, unknown>): boolean {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    const pending = requestId ? this.pendingVoice.get(requestId) : null;
    if (!pending || pending.workerId !== workerId) return false;
    if (payload.type === "voice.synthesize.error") {
      this.finishVoiceRequest(requestId, new Error(typeof payload.message === "string" ? payload.message.slice(0, 500) : "Voice worker synthesis failed"));
      return true;
    }
    if (payload.type === "voice.synthesize.begin") {
      const total = Number(payload.total);
      const mimeType = payload.mimeType === "audio/mpeg" ? "audio/mpeg" : payload.mimeType === "audio/wav" ? "audio/wav" : "";
      if (!Number.isInteger(total) || total < 1 || total > 512 || !mimeType) {
        this.finishVoiceRequest(requestId, new Error("Voice worker returned invalid audio metadata"));
      } else {
        pending.total = total;
        pending.mimeType = mimeType;
      }
      return true;
    }
    if (payload.type === "voice.synthesize.chunk") {
      const index = Number(payload.index);
      const data = typeof payload.data === "string" ? payload.data : "";
      if (pending.total === null || !Number.isInteger(index) || index < 0 || index >= pending.total || data.length > 12_000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) {
        this.finishVoiceRequest(requestId, new Error("Voice worker returned invalid audio chunk"));
        return true;
      }
      const bytes = Buffer.from(data, "base64");
      if (!bytes.length || bytes.length > 4 * 1024 || pending.chunks.has(index)) {
        this.finishVoiceRequest(requestId, new Error("Voice worker returned invalid audio chunk"));
        return true;
      }
      pending.chunks.set(index, bytes);
      return true;
    }
    if (payload.type === "voice.synthesize.end") {
      if (pending.total === null || pending.mimeType === null || pending.chunks.size !== pending.total) {
        this.finishVoiceRequest(requestId, new Error("Voice worker audio transfer was incomplete"));
        return true;
      }
      const bytes = Buffer.concat([...Array(pending.total).keys()].map((index) => pending.chunks.get(index)!));
      if (!bytes.length || bytes.length > 2 * 1024 * 1024) {
        this.finishVoiceRequest(requestId, new Error("Voice worker audio size is invalid"));
      } else {
        this.finishVoiceRequest(requestId, null, { id: crypto.randomUUID(), mimeType: pending.mimeType, bytes });
      }
      return true;
    }
    return false;
  }

  private finishVoiceRequest(requestId: string, error: Error | null, voice?: GeneratedVoice): void {
    const pending = this.pendingVoice.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingVoice.delete(requestId);
    if (error) pending.reject(error);
    else pending.resolve(voice!);
  }

  private rejectVoiceRequests(workerId: string | undefined, error: Error): void {
    for (const [requestId, pending] of this.pendingVoice) {
      if (workerId && pending.workerId !== workerId) continue;
      this.finishVoiceRequest(requestId, error);
    }
  }

  private rejectQqRequests(workerId: string | undefined, error: Error): void {
    for (const [requestId, pending] of this.pendingQq) {
      if (workerId && pending.workerId !== workerId) continue;
      clearTimeout(pending.timer); this.pendingQq.delete(requestId); pending.reject(error);
    }
    for (const [requestId, pending] of this.pendingQqImages) {
      if (workerId && pending.workerId !== workerId) continue;
      clearTimeout(pending.timer); this.pendingQqImages.delete(requestId); pending.reject(error);
    }
  }

  private handleQqWorkerEvent(workerId: string, payload: Record<string, unknown>): boolean {
    if (payload.type === "qq.inbound") {
      const node = this.runtimeNodes?.list().find((item) => item.id === workerId && item.capabilities.includes("qq.receive"));
      if (node) this.onQqInbound?.(payload.event);
      return true;
    }
    if (this.handleQqImageResult(workerId, payload)) return true;
    if (payload.type !== "qq.send.result" || typeof payload.requestId !== "string") return false;
    const pending = this.pendingQq.get(payload.requestId);
    if (!pending || pending.workerId !== workerId) return true;
    clearTimeout(pending.timer); this.pendingQq.delete(payload.requestId);
    if (payload.ok === true && payload.result && typeof payload.result === "object") pending.resolve(payload.result as Record<string, unknown>);
    else pending.reject(new Error(typeof payload.message === "string" ? payload.message : "QQ Worker send failed"));
    return true;
  }

  private handleQqImageResult(workerId: string, payload: Record<string, unknown>): boolean {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    const pending = requestId ? this.pendingQqImages.get(requestId) : null;
    if (!pending || pending.workerId !== workerId) return false;
    if (payload.type === "qq.get_image.error") {
      clearTimeout(pending.timer); this.pendingQqImages.delete(requestId);
      pending.reject(new Error(typeof payload.message === "string" ? payload.message.slice(0, 500) : "QQ Worker image lookup failed"));
      return true;
    }
    if (payload.type === "qq.get_image.begin") {
      const total = Number(payload.total);
      const size = Number(payload.size);
      if (!Number.isInteger(total) || total < 1 || total > Math.ceil(MAX_QQ_IMAGE_BYTES / QQ_TRANSFER_CHUNK_BYTES) || !Number.isInteger(size) || size < 1 || size > MAX_QQ_IMAGE_BYTES) {
        clearTimeout(pending.timer); this.pendingQqImages.delete(requestId); pending.reject(new Error("QQ Worker returned invalid image metadata"));
      } else {
        pending.total = total;
        pending.metadata = {
          ...(typeof payload.url === "string" ? { url: payload.url.slice(0, 2000) } : {}),
          ...(Number.isInteger(payload.file_size) ? { file_size: Number(payload.file_size) } : {}),
          ...(typeof payload.file_name === "string" ? { file_name: payload.file_name.slice(0, 255) } : {}),
        };
      }
      return true;
    }
    if (payload.type === "qq.get_image.chunk") {
      const index = Number(payload.index); const data = typeof payload.data === "string" ? payload.data : "";
      if (pending.total === null || !Number.isInteger(index) || index < 0 || index >= pending.total || data.length > 12_000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) {
        clearTimeout(pending.timer); this.pendingQqImages.delete(requestId); pending.reject(new Error("QQ Worker returned invalid image chunk"));
      } else {
        const bytes = Buffer.from(data, "base64");
        if (!bytes.length || bytes.length > QQ_TRANSFER_CHUNK_BYTES || pending.chunks.has(index)) {
          clearTimeout(pending.timer); this.pendingQqImages.delete(requestId); pending.reject(new Error("QQ Worker returned invalid image chunk"));
        } else pending.chunks.set(index, bytes);
      }
      return true;
    }
    if (payload.type === "qq.get_image.end") {
      const bytes = pending.total === null || pending.chunks.size !== pending.total ? null : Buffer.concat([...Array(pending.total).keys()].map((index) => pending.chunks.get(index)!));
      clearTimeout(pending.timer); this.pendingQqImages.delete(requestId);
      if (!bytes || !bytes.length || bytes.length > MAX_QQ_IMAGE_BYTES) pending.reject(new Error("QQ Worker image transfer was incomplete"));
      else pending.resolve({ ...pending.metadata, bytes });
      return true;
    }
    return false;
  }

  private async sendVoice(clientId: string, voice: NonNullable<CompanionChatResponse["voice"]>): Promise<void> {
    // A voice chunk is base64 encoded, then encrypted and encoded again for
    // relay transport. Keep the original bytes small enough for restrictive
    // WebSocket proxies as well as the relay's own frame limit.
    const size = 4 * 1024;
    const total = Math.ceil(voice.bytes.length / size);
    console.log(`[voice] relay transfer begin client=${clientId} bytes=${voice.bytes.length} chunks=${total}`);
    await this.sendEncrypted(clientId, { type: "voice.audio.begin", id: voice.id, mimeType: voice.mimeType, total });
    for (let index = 0; index < total; index += 1) {
      const bytes = voice.bytes.subarray(index * size, Math.min(voice.bytes.length, (index + 1) * size));
      await this.sendEncrypted(clientId, { type: "voice.audio.chunk", id: voice.id, index, data: Buffer.from(bytes).toString("base64") });
    }
    await this.sendEncrypted(clientId, { type: "voice.audio.end", id: voice.id });
    console.log(`[voice] relay transfer queued client=${clientId} chunks=${total}`);
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    console.log("[companion-relay] heartbeat enabled interval=20s timeout=55s");
    this.heartbeatTimer = setInterval(() => {
      if (socket !== this.socket || socket.readyState !== WebSocket.OPEN || !this.authenticated) return;
      if (Date.now() - this.lastPongAt > 55_000) {
        console.warn("[companion-relay] heartbeat timed out; reconnecting");
        socket.close(4008, "Heartbeat timeout");
        return;
      }
      socket.send(JSON.stringify({ type: "relay.ping", at: Date.now() }));
    }, 20_000);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

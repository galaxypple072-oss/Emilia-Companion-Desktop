import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createRuntimeAnnouncement, deriveRelayCredentials, openRelayPayload, parsePairingCode, sealRelayPayload } from "../../../packages/companion-relay-protocol/src/index.js";
import { loadConfig, type OneBotConfig } from "./config.ts";
import { loadDotEnv } from "./env.ts";
import { OneBotClient } from "./onebot-client.ts";

export interface RelayQqWorkerConfig { url: string; pairingCode: string; nodeId: string; name: string; oneBot: OneBotConfig; }
interface Credentials { deviceId: string; authToken: string; encryptionKey: CryptoKey; }
interface PendingUpload {
  kind: "image" | "file";
  recipientId: string;
  name: string;
  summary?: string;
  subType?: number;
  size: number;
  total: number;
  chunks: Map<number, Buffer>;
  timer: NodeJS.Timeout;
}
const TRANSFER_CHUNK_BYTES = 4 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function relayUrl(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) throw new Error("COMPANION_RELAY_URL is required for QQ Worker");
  const url = new URL(raw);
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new Error("COMPANION_RELAY_URL is invalid");
  url.hash = "";
  return url.toString();
}

export function loadRelayQqWorkerConfig(env: NodeJS.ProcessEnv = process.env): RelayQqWorkerConfig | null {
  if (env.EMILIA_QQ_WORKER_ENABLED?.trim().toLowerCase() !== "true") return null;
  const pairingCode = env.COMPANION_RELAY_PAIRING_CODE?.trim() ?? "";
  parsePairingCode(pairingCode);
  const nodeId = env.EMILIA_QQ_WORKER_ID?.trim() || "windows-qq";
  const name = env.EMILIA_QQ_WORKER_NAME?.trim() || "Windows QQ";
  createRuntimeAnnouncement({ nodeId, name, capabilities: ["qq.receive", "qq.send", "host.health"] });
  return { url: relayUrl(env.COMPANION_RELAY_URL), pairingCode, nodeId, name, oneBot: loadConfig(env) };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
}

/** The Windows-only QQ boundary. Core exchanges encrypted messages and bytes
 * with this worker; only this process reaches the local NapCat HTTP/WS APIs. */
export class RelayQqWorker {
  private readonly config: RelayQqWorkerConfig;
  private readonly client: OneBotClient;
  private credentials: Credentials | null = null;
  private socket: WebSocket | null = null;
  private authenticated = false;
  private legacyRelay = false;
  private receiveChain: Promise<void> = Promise.resolve();
  private readonly uploads = new Map<string, PendingUpload>();

  constructor(config: RelayQqWorkerConfig, client = new OneBotClient(config.oneBot)) { this.config = config; this.client = client; }

  async run(signal: AbortSignal): Promise<void> {
    this.credentials = await deriveRelayCredentials(this.config.pairingCode) as Credentials;
    void this.observeOneBot(signal);
    let retry = 0;
    while (!signal.aborted) {
      try { await this.connectOnce(signal); retry = 0; }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!signal.aborted) console.warn(`[qq-worker] disconnected: ${detail}`);
        if (!this.legacyRelay && /credentials are invalid|authentication failed/iu.test(detail)) { this.legacyRelay = true; console.log("[qq-worker] using legacy Relay transport compatibility"); }
      }
      if (!signal.aborted) await delay(Math.min(30_000, 1000 * 2 ** Math.min(5, retry++)), signal);
    }
    this.socket?.close(1000, "QQ Worker stopping");
    this.clearUploads();
    await this.receiveChain;
  }

  private connectOnce(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.config.url, { maxPayload: 64 * 1024 }); this.socket = socket; this.authenticated = false;
      let settled = false;
      const abort = (): void => { socket.close(1000, "QQ Worker stopping"); finish(); };
      const finish = (error?: Error): void => { if (settled) return; settled = true; signal.removeEventListener("abort", abort); if (this.socket === socket) this.socket = null; this.authenticated = false; error ? reject(error) : resolve(); };
      signal.addEventListener("abort", abort, { once: true });
      socket.on("open", () => socket.send(JSON.stringify({ type: "relay.auth", role: this.legacyRelay ? "client" : "worker", deviceId: this.credentials!.deviceId, peerId: this.config.nodeId, authToken: this.credentials!.authToken })));
      socket.on("message", (raw) => { this.receiveChain = this.receiveChain.then(() => this.receive(socket, String(raw))).catch((error) => console.warn(`[qq-worker] frame failed: ${error instanceof Error ? error.message : String(error)}`)); });
      socket.on("error", (error) => finish(error));
      socket.on("close", (code, reason) => finish(signal.aborted ? undefined : new Error(`connection closed (${code}${reason.length ? `: ${String(reason)}` : ""})`)));
    });
  }

  private async receive(socket: WebSocket, raw: string): Promise<void> {
    let event: Record<string, unknown>; try { event = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (event.type === "relay.auth.ok") { if (socket !== this.socket) return; this.authenticated = true; await this.announce(); console.log(`[qq-worker] connected node=${this.config.nodeId}`); return; }
    if (event.type === "relay.ping") { socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "relay.pong", at: Date.now() })); return; }
    if (event.type === "relay.peer_online" && event.peerId === "core") return this.announce();
    if (event.type === "relay.auth.error") throw new Error(String(event.message || "Relay authentication failed"));
    if (event.type !== "relay.frame" || event.senderId !== "core") return;
    const payload = await openRelayPayload(this.credentials!, event) as Record<string, unknown>;
    if (payload.type === "qq.send.text") await this.handleTextSend(payload);
    else if (payload.type === "qq.get_image") await this.handleImageLookup(payload);
    else if (payload.type === "qq.send.image.begin") this.beginUpload("image", payload);
    else if (payload.type === "qq.send.file.begin") this.beginUpload("file", payload);
    else if (payload.type === "qq.send.image.chunk" || payload.type === "qq.send.file.chunk") this.receiveUploadChunk(payload);
    else if (payload.type === "qq.send.image.end" || payload.type === "qq.send.file.end") await this.finishUpload(payload);
  }

  private async announce(): Promise<void> { await this.send("core", createRuntimeAnnouncement({ nodeId: this.config.nodeId, name: this.config.name, capabilities: ["qq.receive", "qq.send", "host.health"] })); }

  private async handleTextSend(payload: Record<string, unknown>): Promise<void> {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    const recipientId = typeof payload.recipientId === "string" ? payload.recipientId : "";
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!/^[A-Za-z0-9_-]{3,100}$/u.test(requestId) || !text || text.length > 4000) return;
    try { const result = await this.client.sendPrivateMessage(recipientId, text); await this.send("core", { type: "qq.send.result", requestId, ok: true, result }); }
    catch (error) { await this.send("core", { type: "qq.send.result", requestId, ok: false, message: error instanceof Error ? error.message.slice(0, 500) : "QQ send failed" }); }
  }

  private beginUpload(kind: "image" | "file", payload: Record<string, unknown>): void {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    const recipientId = typeof payload.recipientId === "string" ? payload.recipientId : "";
    const total = Number(payload.total); const size = Number(payload.size);
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (!/^[A-Za-z0-9_-]{3,100}$/u.test(requestId) || !recipientId || !Number.isInteger(total) || total < 1 || total > Math.ceil(limit / TRANSFER_CHUNK_BYTES) || !Number.isInteger(size) || size < 1 || size > limit || !name || name.length > 255 || this.uploads.has(requestId)) return;
    const timer = setTimeout(() => this.discardUpload(requestId), 180_000);
    this.uploads.set(requestId, {
      kind, recipientId, name,
      ...(typeof payload.summary === "string" ? { summary: payload.summary.slice(0, 200) } : {}),
      ...(Number.isInteger(payload.subType) ? { subType: Number(payload.subType) } : {}),
      size, total, chunks: new Map(), timer,
    });
  }

  private receiveUploadChunk(payload: Record<string, unknown>): void {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    const pending = this.uploads.get(requestId); if (!pending) return;
    const index = Number(payload.index); const data = typeof payload.data === "string" ? payload.data : "";
    if (!Number.isInteger(index) || index < 0 || index >= pending.total || data.length > 12_000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) return this.discardUpload(requestId);
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > TRANSFER_CHUNK_BYTES || pending.chunks.has(index)) return this.discardUpload(requestId);
    pending.chunks.set(index, bytes);
  }

  private async finishUpload(payload: Record<string, unknown>): Promise<void> {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    const pending = this.uploads.get(requestId); if (!pending) return;
    this.uploads.delete(requestId); clearTimeout(pending.timer);
    const bytes = pending.chunks.size === pending.total ? Buffer.concat([...Array(pending.total).keys()].map((index) => pending.chunks.get(index)!)) : null;
    if (!bytes || bytes.length !== pending.size) return void this.send("core", { type: "qq.send.result", requestId, ok: false, message: "QQ Worker attachment transfer was incomplete" });
    try {
      const result = pending.kind === "image"
        ? await this.client.sendPrivateImage(pending.recipientId, `base64://${bytes.toString("base64")}`, { ...(pending.summary ? { summary: pending.summary } : {}), ...(Number.isInteger(pending.subType) ? { subType: pending.subType } : {}) })
        : await this.uploadFile(pending.recipientId, pending.name, bytes);
      await this.send("core", { type: "qq.send.result", requestId, ok: true, result });
    } catch (error) {
      await this.send("core", { type: "qq.send.result", requestId, ok: false, message: error instanceof Error ? error.message.slice(0, 500) : "QQ attachment send failed" });
    }
  }

  private async uploadFile(recipientId: string, name: string, bytes: Buffer): Promise<Record<string, unknown>> {
    const directory = await mkdtemp(join(tmpdir(), "emilia-qq-upload-"));
    const path = join(directory, name);
    try { await writeFile(path, bytes, { flag: "wx" }); return await this.client.sendPrivateFile(recipientId, path, name); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async handleImageLookup(payload: Record<string, unknown>): Promise<void> {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    const imageId = typeof payload.file === "string" ? payload.file.trim() : "";
    if (!/^[A-Za-z0-9_-]{3,100}$/u.test(requestId) || !imageId || imageId.length > 2000) return;
    try {
      const info = await this.client.getImage(imageId);
      if (!info.file) throw new Error("NapCat did not return a local image path");
      const path = info.file.startsWith("file:") ? fileURLToPath(info.file) : info.file;
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_IMAGE_BYTES) throw new Error("NapCat image exceeds the 50MB transfer limit");
      const bytes = await readFile(path); const total = Math.ceil(bytes.length / TRANSFER_CHUNK_BYTES);
      await this.send("core", { type: "qq.get_image.begin", requestId, total, size: bytes.length, ...(typeof info.url === "string" ? { url: info.url } : {}), ...(Number.isInteger(info.file_size) ? { file_size: info.file_size } : {}), file_name: typeof info.file_name === "string" ? info.file_name : basename(path) });
      for (let index = 0; index < total; index += 1) {
        const chunk = bytes.subarray(index * TRANSFER_CHUNK_BYTES, Math.min(bytes.length, (index + 1) * TRANSFER_CHUNK_BYTES));
        await this.send("core", { type: "qq.get_image.chunk", requestId, index, data: chunk.toString("base64") });
      }
      await this.send("core", { type: "qq.get_image.end", requestId });
    } catch (error) {
      await this.send("core", { type: "qq.get_image.error", requestId, message: error instanceof Error ? error.message.slice(0, 500) : "QQ image lookup failed" });
    }
  }

  private discardUpload(requestId: string): void { const pending = this.uploads.get(requestId); if (!pending) return; clearTimeout(pending.timer); this.uploads.delete(requestId); }
  private clearUploads(): void { for (const requestId of this.uploads.keys()) this.discardUpload(requestId); }

  private async observeOneBot(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.listenOneBot(signal); } catch (error) { if (!signal.aborted) console.warn(`[qq-worker] OneBot disconnected: ${error instanceof Error ? error.message : String(error)}`); }
      if (!signal.aborted) await delay(5000, signal);
    }
  }

  private listenOneBot(signal: AbortSignal): Promise<void> {
    const url = new URL(this.config.oneBot.wsUrl); url.searchParams.set("access_token", this.config.oneBot.accessToken);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url); let settled = false;
      const finish = (error?: Error): void => { if (settled) return; settled = true; signal.removeEventListener("abort", abort); socket.close(); error ? reject(error) : resolve(); };
      const abort = (): void => finish(); signal.addEventListener("abort", abort, { once: true });
      socket.on("error", () => finish(new Error("OneBot WebSocket error")));
      socket.on("close", () => finish());
      socket.on("message", (raw) => {
        try {
          const event = JSON.parse(String(raw)) as Record<string, unknown>;
          if (event.post_type !== "message" || event.message_type !== "private" || !this.config.oneBot.allowedQQs.has(String(event.user_id))) return;
          void this.send("core", { type: "qq.inbound", event });
        } catch { /* malformed OneBot event is ignored */ }
      });
    });
  }

  private async send(recipientId: string, payload: Record<string, unknown>): Promise<void> {
    const socket = this.socket; if (!socket || socket.readyState !== WebSocket.OPEN || !this.authenticated || !this.credentials) return;
    const frame = await sealRelayPayload(this.credentials, { senderId: this.config.nodeId, recipientId, payload });
    if (socket === this.socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }
}

async function main(): Promise<void> {
  loadDotEnv(resolve(process.cwd(), ".env")); const config = loadRelayQqWorkerConfig(); if (!config) return;
  const controller = new AbortController(); process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
  await new RelayQqWorker(config).run(controller.signal);
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/relay-worker.ts")) main().catch((error) => { console.error(`[qq-worker] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { CompanionEndpoint } from "./companion-endpoint.ts";
import type { DeviceControlRouter } from "./device-control-router.ts";
import { ScopedFileService } from "../../file-mcp/src/file-service.ts";
import { detectImageMediaType, prepareVisionImage, type VisionAdapter } from "./vision.ts";

export interface DeviceControlApiConfig {
  host: "127.0.0.1";
  port: number;
  token: string;
}

export function loadDeviceControlApiConfig(env: NodeJS.ProcessEnv = process.env): DeviceControlApiConfig | null {
  if (env.DEVICE_CONTROL_ENABLED?.trim().toLowerCase() === "false") return null;
  const secret = env.DEVICE_CONTROL_API_TOKEN?.trim()
    || env.COMPANION_BRIDGE_TOKEN?.trim()
    || env.COMPANION_RELAY_PAIRING_CODE?.trim()
    || "";
  if (!secret) return null;
  const port = Number(env.DEVICE_CONTROL_API_PORT ?? 8766);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("DEVICE_CONTROL_API_PORT must be between 1024 and 65535");
  return {
    host: "127.0.0.1",
    port,
    token: createHash("sha256").update(`emilia-device-api-v1:${secret}`).digest("base64url"),
  };
}

function authorized(request: IncomingMessage, token: string): boolean {
  const received = request.headers.authorization?.replace(/^Bearer\s+/iu, "") ?? "";
  const left = Buffer.from(received);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 32_000) throw new Error("Request is too large");
  }
  const value = JSON.parse(body || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object");
  return value as Record<string, unknown>;
}

export class DeviceControlApiServer implements CompanionEndpoint {
  private readonly config: DeviceControlApiConfig;
  private readonly devices: DeviceControlRouter;
  private readonly vision: VisionAdapter | null;
  private readonly visionMaxImageBytes: number;

  constructor(config: DeviceControlApiConfig, devices: DeviceControlRouter, vision: VisionAdapter | null = null, visionMaxImageBytes = 8 * 1024 * 1024) {
    this.config = config;
    this.devices = devices;
    this.vision = vision;
    this.visionMaxImageBytes = visionMaxImageBytes;
  }

  async run(signal: AbortSignal): Promise<void> {
    const server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
      server.listen(this.config.port, this.config.host);
    });
    console.log(`[device-control] local API listening on http://${this.config.host}:${this.config.port}`);
    await new Promise<void>((resolve) => signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  broadcast(_event: Record<string, unknown>): void {}

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!authorized(request, this.config.token)) return json(response, 401, { error: "Unauthorized" });
      if (request.method === "GET" && request.url === "/v1/devices") return json(response, 200, { devices: this.devices.list() });
      if (request.method !== "POST") return json(response, 404, { error: "Not found" });
      const body = await readJson(request);
      if (request.url === "/v1/documents/parse") return json(response, 200, await this.parseDeviceDocument(body));
      if (request.url === "/v1/screens/analyze") return json(response, 200, await this.analyzeDeviceScreen(body));
      if (request.url !== "/v1/commands") return json(response, 404, { error: "Not found" });
      const target = typeof body.target === "string" ? body.target.slice(0, 80) : "";
      const capability = typeof body.capability === "string" ? body.capability.slice(0, 60) : "";
      const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input as Record<string, unknown> : {};
      if (!target || !capability) return json(response, 400, { error: "target and capability are required" });
      const output = await this.devices.execute(target, capability, input);
      json(response, 200, { ok: true, output });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async parseDeviceDocument(body: Record<string, unknown>): Promise<unknown> {
    const target = typeof body.target === "string" ? body.target.slice(0, 80) : "";
    const path = typeof body.path === "string" ? body.path.slice(0, 2000) : "";
    const maxChars = Math.max(1000, Math.min(100_000, Number(body.maxChars) || 50_000));
    if (!target || !path) throw new Error("target and path are required");
    const payload = await this.devices.execute(target, "files.read_document", { path }, 90_000);
    const binary = decodeDeviceBinary(payload, 8 * 1024 * 1024);
    const extension = extname(binary.name).toLowerCase();
    if (![".pdf", ".docx", ".xlsx"].includes(extension)) throw new Error("Device document type is unsupported");
    const directory = await mkdtemp(join(tmpdir(), "emilia-device-doc-"));
    const localPath = join(directory, `document${extension}`);
    try {
      await writeFile(localPath, binary.bytes, { flag: "wx" });
      const service = await ScopedFileService.create([directory]);
      const parsed = await service.parseDocument(localPath, maxChars);
      return { ok: true, document: { ...parsed, path: binary.path, name: binary.name } };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async analyzeDeviceScreen(body: Record<string, unknown>): Promise<unknown> {
    if (!this.vision) throw new Error("Vision model is not configured");
    const target = typeof body.target === "string" ? body.target.slice(0, 80) : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 2000) : "";
    if (!target) throw new Error("target is required");
    const payload = await this.devices.execute(target, "screen.capture", {}, 90_000);
    const binary = decodeDeviceBinary(payload, 12 * 1024 * 1024);
    const mediaType = detectImageMediaType(binary.bytes);
    if (!mediaType) throw new Error("Device returned an unsupported screenshot format");
    const image = await prepareVisionImage({ bytes: binary.bytes, mediaType }, this.visionMaxImageBytes);
    const analysis = await this.vision.analyze(image, prompt || "请客观描述当前屏幕上的主要内容，不要猜测被遮挡或看不清的信息。");
    return { ok: true, screenshot: { device: target, size: binary.bytes.length, mediaType }, analysis };
  }
}

export function decodeDeviceBinary(value: unknown, maxBytes: number): { bytes: Buffer; name: string; path: string; sha256: string } {
  if (!value || typeof value !== "object") throw new Error("Device returned malformed binary data");
  const item = value as Record<string, unknown>;
  const name = basename(String(item.name ?? "")).slice(0, 255);
  const path = String(item.path ?? "").slice(0, 2000);
  const data = String(item.data ?? "");
  if (!name || !path || !data || data.length > Math.ceil(maxBytes * 4 / 3) + 16) throw new Error("Device binary data exceeds the limit");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > maxBytes || Number(item.size) !== bytes.length) throw new Error("Device binary data failed validation");
  return { bytes, name, path, sha256: createHash("sha256").update(bytes).digest("hex") };
}

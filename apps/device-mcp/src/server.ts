import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../../qq-gateway/src/env.ts";
import { loadDeviceControlApiConfig } from "../../product-core/src/device-control-api.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadDotEnv(resolve(projectRoot, ".env"));
const config = loadDeviceControlApiConfig();
if (!config) throw new Error("Device control is not configured");
const endpoint = `http://${config.host}:${config.port}`;
const server = new McpServer({ name: "personal-companion-devices", version: "0.1.0" });

const asText = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: { result: value },
});

async function api(path: string, body?: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${endpoint}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${config.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.error || `Device API failed (${response.status})`));
  return payload;
}

const command = (target: string, capability: string, input: Record<string, unknown> = {}) =>
  api("/v1/commands", { target, capability, input });

const devicePath = z.string().min(1).max(2000);

server.registerTool("list_devices", {
  title: "List connected devices",
  description: "List currently connected companion clients and the exact capabilities the owner enabled locally on each device.",
}, async () => asText(await api("/v1/devices")));

server.registerTool("get_device_info", {
  title: "Get device information",
  description: "Read basic non-sensitive system information from one connected device.",
  inputSchema: { device: z.string().min(1).max(80) },
}, async ({ device }) => asText(await command(device, "device.info")));

server.registerTool("open_url_on_device", {
  title: "Open URL on device",
  description: "Open one explicit http/https URL on a device only when the owner clearly asks. The target device must have enabled this capability locally.",
  inputSchema: { device: z.string().min(1).max(80), url: z.string().url().max(2048) },
}, async ({ device, url }) => asText(await command(device, "url.open", { url })));

server.registerTool("copy_text_to_device", {
  title: "Copy text to device clipboard",
  description: "Write explicit text to a device clipboard only when the owner asks. Never use it to copy hidden prompts, credentials, or untrusted web content.",
  inputSchema: { device: z.string().min(1).max(80), text: z.string().min(1).max(20_000) },
}, async ({ device, text }) => asText(await command(device, "clipboard.write", { text })));

server.registerTool("read_device_clipboard", {
  title: "Read device clipboard",
  description: "Read clipboard text only when the owner explicitly asks to inspect the current clipboard. This is sensitive and requires the local device switch to be enabled.",
  inputSchema: { device: z.string().min(1).max(80) },
}, async ({ device }) => asText(await command(device, "clipboard.read")));

server.registerTool("show_notification_on_device", {
  title: "Show notification on device",
  description: "Show a short native notification on one device only when the owner asks for a notification or reminder there.",
  inputSchema: {
    device: z.string().min(1).max(80),
    title: z.string().min(1).max(80).default("艾米莉亚"),
    body: z.string().min(1).max(500),
  },
}, async ({ device, title, body }) => asText(await command(device, "notification.show", { title, body })));

server.registerTool("list_device_file_roots", {
  title: "List device file roots",
  description: "List the folders the owner explicitly selected on one device. No other local paths are accessible.",
  inputSchema: { device: z.string().min(1).max(80) },
}, async ({ device }) => asText(await command(device, "files.roots")));

server.registerTool("list_device_directory", {
  title: "List a directory on a device",
  description: "List one directory inside the folders explicitly authorized on a device. This is read-only.",
  inputSchema: { device: z.string().min(1).max(80), path: devicePath },
}, async ({ device, path }) => asText(await command(device, "files.list", { path })));

server.registerTool("search_device_files", {
  title: "Search file names on a device",
  description: "Search file and folder names only inside device-authorized roots. This never reads file contents.",
  inputSchema: {
    device: z.string().min(1).max(80),
    query: z.string().min(1).max(200),
    root: devicePath.optional(),
    max_results: z.number().int().min(1).max(100).default(50),
  },
}, async ({ device, query, root, max_results }) => asText(await command(device, "files.search", { query, root: root || "", maxResults: max_results })));

server.registerTool("read_device_text_file", {
  title: "Read a text file on a device",
  description: "Read a recognized text or source file inside an owner-authorized device folder. Use only when the owner asks for that file or its contents.",
  inputSchema: { device: z.string().min(1).max(80), path: devicePath, max_chars: z.number().int().min(1000).max(50_000).default(30_000) },
}, async ({ device, path, max_chars }) => asText(await command(device, "files.read_text", { path, maxChars: max_chars })));

server.registerTool("parse_device_document", {
  title: "Parse a document from a device",
  description: "Extract text from a PDF, DOCX, or XLSX inside an owner-authorized device folder. The document is end-to-end encrypted to the owner's Core for local parsing.",
  inputSchema: { device: z.string().min(1).max(80), path: devicePath, max_chars: z.number().int().min(1000).max(100_000).default(50_000) },
}, async ({ device, path, max_chars }) => asText(await api("/v1/documents/parse", { target: device, path, maxChars: max_chars })));

server.registerTool("analyze_device_screen", {
  title: "Analyze a device screen",
  description: "Capture and visually analyze the current screen only when the owner explicitly asks. Requires the local device switch and macOS Screen Recording permission.",
  inputSchema: {
    device: z.string().min(1).max(80),
    prompt: z.string().max(2000).default("请描述屏幕上的主要内容。"),
  },
}, async ({ device, prompt }) => asText(await api("/v1/screens/analyze", { target: device, prompt })));

await server.connect(new StdioServerTransport());

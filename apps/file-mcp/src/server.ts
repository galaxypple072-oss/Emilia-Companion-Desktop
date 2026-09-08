import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadAllowedRoots, ScopedFileService } from "./file-service.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadDotEnv } from "../../qq-gateway/src/env.ts";
import { loadProductCoreConfig } from "../../product-core/src/config.ts";
import { ProductStore } from "../../product-core/src/store.ts";
import { WebImageService } from "../../product-core/src/web-image.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadDotEnv(resolve(projectRoot, ".env"));
const files = await ScopedFileService.create(loadAllowedRoots());
const store = new ProductStore(loadProductCoreConfig().databasePath);
const webImages = new WebImageService();
const server = new McpServer({ name: "personal-companion-files", version: "0.1.0" });

const asText = (value: unknown): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: { result: value },
});

server.registerTool("list_allowed_folders", {
  title: "List allowed folders",
  description: "List the only Windows folders this assistant may access.",
}, async () => asText(files.allowedRoots()));

server.registerTool("list_directory", {
  title: "List directory",
  description: "List files and folders directly inside an allowed directory. Never accesses paths outside the configured roots.",
  inputSchema: { path: z.string().min(3).max(1000) },
}, async ({ path }) => asText(await files.listDirectory(path)));

server.registerTool("search_files", {
  title: "Search files",
  description: "Recursively search allowed folders by a case-insensitive file or folder name fragment.",
  inputSchema: { query: z.string().min(1).max(200), max_results: z.number().int().min(1).max(100).default(50) },
}, async ({ query, max_results }) => asText(await files.search(query, max_results)));

server.registerTool("get_file_info", {
  title: "Get file info",
  description: "Get safe metadata for one file or directory inside the allowed folders.",
  inputSchema: { path: z.string().min(3).max(1000) },
}, async ({ path }) => asText(await files.fileInfo(path)));

server.registerTool("read_text_file", {
  title: "Read text file",
  description: "Read a recognized text or source-code file inside the allowed folders. Binary documents are not supported yet.",
  inputSchema: { path: z.string().min(3).max(1000), max_chars: z.number().int().min(1000).max(50_000).default(30_000) },
}, async ({ path, max_chars }) => asText(await files.readText(path, max_chars)));

server.registerTool("parse_document", {
  title: "Parse document",
  description: "Extract local text from a PDF, DOCX, or XLSX document in an allowed folder. Scanned PDFs require future OCR support.",
  inputSchema: { path: z.string().min(3).max(1000), max_chars: z.number().int().min(1000).max(100_000).default(50_000) },
}, async ({ path, max_chars }) => asText(await files.parseDocument(path, max_chars)));

server.registerTool("create_directory", {
  title: "Create directory",
  description: "Create one directory inside an allowed folder only when the owner explicitly asks. Parent must already exist. Never overwrites anything.",
  inputSchema: { path: z.string().min(3).max(1000) },
}, async ({ path }) => asText({ created: await files.createDirectory(path) }));

server.registerTool("move_or_rename", {
  title: "Move or rename file",
  description: "Move or rename one file or directory within the allowed folders only when explicitly requested. Destination must not exist; overwrite and delete are impossible.",
  inputSchema: { source: z.string().min(3).max(1000), destination: z.string().min(3).max(1000) },
}, async ({ source, destination }) => asText(await files.move(source, destination)));

server.registerTool("draft_send_file_to_owner", {
  title: "Draft sending a file to owner",
  description: "Create a confirmation-required action to upload one existing file from an allowed folder to the owner's private QQ. This never sends immediately.",
  inputSchema: { path: z.string().min(3).max(1000), display_name: z.string().min(1).max(255).optional() },
}, async ({ path, display_name }) => {
  const info = await files.fileInfo(path);
  if (info.type !== "file" || info.size === undefined) throw new Error("Only a regular file can be sent");
  if (info.size > 200 * 1024 * 1024) throw new Error("Files larger than 200 MB cannot be sent by this tool");
  const result = store.createAction({
    kind: "send_qq_file",
    summary: `发送文件到用户 QQ：${display_name || info.name}`,
    payload: { path: info.path, name: display_name || info.name, size: info.size },
    dedupeKey: `mcp-file:${randomUUID()}`,
  });
  const token = result.id.slice(0, 8);
  return asText({ drafted: true, actionId: result.id, path: info.path, name: display_name || info.name, confirmationCommand: `/confirm ${token}` });
});

server.registerTool("send_web_image_to_owner", {
  title: "Send a web image to owner",
  description: "After one web_search, validate a direct image URL or a public source page with og:image and queue it as a native image to the owner's QQ. Use only when the owner explicitly asks to find and send an online image. It can never send to another recipient.",
  inputSchema: { source_url: z.string().url().max(3000), description: z.string().min(1).max(200).optional() },
}, async ({ source_url, description }) => {
  const resolved = await webImages.resolve(source_url);
  if (Math.max(resolved.width, resolved.height) < 1000 || Math.min(resolved.width, resolved.height) < 500) {
    throw new Error(`Only a low-resolution preview was found (${resolved.width}x${resolved.height}); choose a different search result source`);
  }
  const result = store.createAction({
    kind: "send_qq_web_image",
    summary: `发送网络图片到用户 QQ：${description || new URL(resolved.sourceUrl).hostname}`,
    payload: { sourceUrl: resolved.sourceUrl, imageUrl: resolved.imageUrl, description: description || "网上找到的图片", expectedSize: resolved.size, width: resolved.width, height: resolved.height },
    dedupeKey: `mcp-web-image:${randomUUID()}`,
  });
  store.confirmAction(result.id);
  return asText({
    queued: true,
    actionId: result.id,
    sourceUrl: resolved.sourceUrl,
    imageUrl: resolved.imageUrl,
    mediaType: resolved.mediaType,
    size: resolved.size,
    width: resolved.width,
    height: resolved.height,
  });
});

function dueTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) throw new Error("due_at must be ISO-8601 with an explicit timezone offset");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp < Date.now() - 300_000) throw new Error("due_at must be a valid current or future time");
  return timestamp;
}

server.registerTool("create_task", {
  title: "Create personal task",
  description: "Create a durable personal task only when the owner clearly asks to remember, track, or remind them about a task. A due time is optional; never invent one when the owner did not provide it.",
  inputSchema: {
    title: z.string().min(1).max(300),
    notes: z.string().max(2000).optional(),
    due_at: z.string().max(80).optional().describe("ISO-8601 with timezone, for example 2026-08-26T15:00:00+08:00"),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
    source_key: z.string().max(200).optional(),
  },
}, async ({ title, notes, due_at, priority, source_key }) => {
  const result = store.createTask({ title, notes, dueAt: dueTimestamp(due_at), priority, sourceKey: source_key });
  return asText({
    created: result.created,
    id: result.task.id,
    token: result.task.id.slice(0, 8),
    title: result.task.title,
    dueAt: result.task.dueAt === null ? null : new Date(result.task.dueAt).toISOString(),
  });
});

server.registerTool("list_tasks", {
  title: "List personal tasks",
  description: "List durable tasks so the assistant can answer task questions or resolve an explicitly referenced task.",
  inputSchema: { status: z.enum(["pending", "completed", "cancelled"]).default("pending"), limit: z.number().int().min(1).max(50).default(20) },
}, async ({ status, limit }) => asText(store.listTasks(status, limit).map((task) => ({
  ...task,
  token: task.id.slice(0, 8),
  dueAt: task.dueAt === null ? null : new Date(task.dueAt).toISOString(),
}))));

server.registerTool("complete_task", {
  title: "Complete personal task",
  description: "Mark one task complete only when the owner explicitly says it is finished. Use list_tasks first if the reference is ambiguous.",
  inputSchema: { task_id: z.string().min(6).max(36) },
}, async ({ task_id }) => asText(store.completeTask(task_id)));

server.registerTool("cancel_task", {
  title: "Cancel personal task",
  description: "Cancel one pending task only when the owner explicitly asks. Use list_tasks first if ambiguous.",
  inputSchema: { task_id: z.string().min(6).max(36) },
}, async ({ task_id }) => asText(store.cancelTask(task_id)));

server.registerTool("snooze_task", {
  title: "Snooze personal task",
  description: "Move a pending task to a new explicit future due time only when the owner asks.",
  inputSchema: { task_id: z.string().min(6).max(36), due_at: z.string().min(10).max(80) },
}, async ({ task_id, due_at }) => asText(store.snoozeTask(task_id, dueTimestamp(due_at)!)));

await server.connect(new StdioServerTransport());

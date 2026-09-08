import { ImapFlow, type FetchMessageObject, type MessageStructureObject, type SearchObject } from "imapflow";
import type { EmailConfig } from "./email.ts";

export interface ImapInboxConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
  pollIntervalMs: number;
  maxMessagesPerPoll: number;
  importantSenders: ReadonlySet<string>;
}

export interface ImapCursor {
  uidValidity: string;
  lastUid: number;
}

export interface IncomingEmailCandidate {
  uidValidity: string;
  uid: number;
  messageId: string | null;
  senderName: string | null;
  senderAddress: string;
  subject: string;
  receivedAt: number;
  textExcerpt: string;
  attachments: Array<{ filename: string; contentType: string; size: number | null }>;
  forceNotify: boolean;
}

export interface ImapPollResult {
  cursor: ImapCursor;
  bootstrapped: boolean;
  messages: IncomingEmailCandidate[];
}

export interface InboxEmailSummary {
  uid: number;
  senderName: string | null;
  senderAddress: string;
  subject: string;
  receivedAt: number;
  seen: boolean;
  attachments: IncomingEmailCandidate["attachments"];
}

export interface InboxEmailDetail extends InboxEmailSummary {
  textExcerpt: string;
}

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} is invalid`);
  return parsed;
}

export function loadImapInboxConfig(env: NodeJS.ProcessEnv, email: EmailConfig | null): ImapInboxConfig | null {
  if (env.EMAIL_INBOX_ENABLED?.trim().toLowerCase() !== "true") return null;
  if (!email) throw new Error("Outgoing email configuration is required to reuse the 163 authorization code");
  const important = new Set([
    email.bossEmail.toLowerCase(),
    ...(env.EMAIL_IMPORTANT_SENDERS ?? "").split(/[;,]/u).map((value) => value.trim().toLowerCase()).filter(Boolean),
  ]);
  return {
    host: env.IMAP_HOST?.trim() || "imap.163.com",
    port: integer(env.IMAP_PORT, 993, 1, 65535, "IMAP_PORT"),
    secure: env.IMAP_SECURE?.trim().toLowerCase() !== "false",
    user: env.IMAP_USER?.trim() || email.user,
    password: env.IMAP_PASSWORD?.trim() || email.password,
    mailbox: env.IMAP_MAILBOX?.trim() || "INBOX",
    pollIntervalMs: integer(env.EMAIL_INBOX_POLL_SECONDS, 120, 30, 3600, "EMAIL_INBOX_POLL_SECONDS") * 1000,
    maxMessagesPerPoll: integer(env.EMAIL_INBOX_BATCH_SIZE, 20, 1, 50, "EMAIL_INBOX_BATCH_SIZE"),
    importantSenders: important,
  };
}

function findTextPart(node: MessageStructureObject | undefined, wanted: "text/plain" | "text/html"): string | null {
  if (!node) return null;
  if (node.type.toLowerCase() === wanted && node.disposition?.toLowerCase() !== "attachment") return node.part || "1";
  for (const child of node.childNodes ?? []) {
    const found = findTextPart(child, wanted);
    if (found) return found;
  }
  return null;
}

function attachmentMetadata(node: MessageStructureObject | undefined, result: IncomingEmailCandidate["attachments"] = []): IncomingEmailCandidate["attachments"] {
  if (!node || result.length >= 30) return result;
  const topType = node.type.toLowerCase().split("/")[0];
  const isAttachment = node.disposition?.toLowerCase() === "attachment"
    || (topType !== "text" && topType !== "multipart" && !node.childNodes?.length);
  if (isAttachment) {
    result.push({
      filename: (node.dispositionParameters?.filename || node.parameters?.name || "未命名附件").slice(0, 255),
      contentType: node.type.slice(0, 120),
      size: Number.isFinite(node.size) ? node.size! : null,
    });
  }
  for (const child of node.childNodes ?? []) attachmentMetadata(child, result);
  return result;
}

async function streamBuffer(stream: NodeJS.ReadableStream, limit = 128 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    const remaining = limit - size;
    if (remaining <= 0) break;
    chunks.push(chunk.subarray(0, remaining));
    size += Math.min(chunk.length, remaining);
  }
  return Buffer.concat(chunks);
}

function decodeText(bytes: Buffer, charset?: string): string {
  try {
    return new TextDecoder(charset || "utf-8", { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/p\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n\s*\n\s*\n+/gu, "\n\n")
    .trim();
}

export class ImapInboxReader {
  private readonly config: ImapInboxConfig;

  constructor(config: ImapInboxConfig) {
    this.config = config;
  }

  async verify(): Promise<{ mailbox: string; exists: number; uidValidity: string; uidNext: number }> {
    try {
      return await this.withMailbox(async (client) => ({
        mailbox: this.config.mailbox,
        exists: client.mailbox ? client.mailbox.exists : 0,
        uidValidity: String(client.mailbox ? client.mailbox.uidValidity : 0),
        uidNext: (await this.latestUid(client)) + 1,
      }));
    } catch (error) {
      const detail = error && typeof error === "object"
        ? String((error as { responseText?: unknown }).responseText || (error as Error).message || "unknown error")
        : String(error);
      const safe = detail.replace(/[\r\n]+/gu, " ").replace(/[\w.+-]+@[\w.-]+/gu, "<account>").slice(0, 500);
      throw new Error(`IMAP verification failed: ${safe}`);
    }
  }

  async poll(cursor: ImapCursor | null): Promise<ImapPollResult> {
    return this.withMailbox(async (client) => {
      if (!client.mailbox) throw new Error("IMAP mailbox did not open");
      const uidValidity = String(client.mailbox.uidValidity);
      const latestUid = await this.latestUid(client);
      if (!cursor || cursor.uidValidity !== uidValidity) {
        return { cursor: { uidValidity, lastUid: latestUid }, bootstrapped: true, messages: [] };
      }
      if (cursor.lastUid >= latestUid) return { cursor, bootstrapped: false, messages: [] };
      const endUid = Math.min(latestUid, cursor.lastUid + this.config.maxMessagesPerPoll);
      const fetched = await client.fetchAll(`${cursor.lastUid + 1}:${endUid}`, {
        envelope: true,
        bodyStructure: true,
        internalDate: true,
        size: true,
      }, { uid: true });
      const messages: IncomingEmailCandidate[] = [];
      for (const message of fetched.sort((a, b) => a.uid - b.uid)) {
        const summary = this.summarize(message);
        messages.push({
          uidValidity,
          ...summary,
          messageId: message.envelope?.messageId?.slice(0, 500) || null,
          textExcerpt: await this.downloadReadableText(client, message),
          forceNotify: this.config.importantSenders.has(summary.senderAddress),
        });
      }
      return { cursor: { uidValidity, lastUid: endUid }, bootstrapped: false, messages };
    });
  }

  async listRecent(limit = 10): Promise<InboxEmailSummary[]> {
    const bounded = Math.max(1, Math.min(30, Math.trunc(limit)));
    return this.withMailbox(async (client) => {
      if (!client.mailbox || client.mailbox.exists === 0) return [];
      const start = Math.max(1, client.mailbox.exists - bounded + 1);
      const messages = await client.fetchAll(`${start}:*`, {
        uid: true, envelope: true, bodyStructure: true, internalDate: true, flags: true,
      });
      return messages.map((message) => this.summarize(message)).sort((a, b) => b.uid - a.uid).slice(0, bounded);
    });
  }

  async search(query: string, field: "any" | "from" | "subject" = "any", limit = 20): Promise<InboxEmailSummary[]> {
    const normalized = query.replace(/[\r\n]+/gu, " ").trim().slice(0, 100);
    if (!normalized) throw new Error("Email search query must not be empty");
    const bounded = Math.max(1, Math.min(30, Math.trunc(limit)));
    const criteria: SearchObject = field === "from" ? { from: normalized }
      : field === "subject" ? { subject: normalized }
        : { text: normalized };
    return this.withMailbox(async (client) => {
      const found = await client.search(criteria, { uid: true });
      if (!found || found.length === 0) return [];
      const messages = await client.fetchAll(found.slice(-bounded), {
        uid: true, envelope: true, bodyStructure: true, internalDate: true, flags: true,
      }, { uid: true });
      return messages.map((message) => this.summarize(message)).sort((a, b) => b.uid - a.uid);
    });
  }

  async read(uid: number): Promise<InboxEmailDetail | null> {
    if (!Number.isInteger(uid) || uid < 1) throw new Error("Email UID is invalid");
    return this.withMailbox(async (client) => {
      const message = await client.fetchOne(String(uid), {
        uid: true, envelope: true, bodyStructure: true, internalDate: true, flags: true,
      }, { uid: true });
      if (!message) return null;
      return { ...this.summarize(message), textExcerpt: await this.downloadReadableText(client, message) };
    });
  }

  private summarize(message: FetchMessageObject): InboxEmailSummary {
    const sender = message.envelope?.from?.[0];
    const internalDate = message.internalDate instanceof Date ? message.internalDate : new Date(message.internalDate || Date.now());
    return {
      uid: message.uid,
      senderName: sender?.name?.trim().slice(0, 200) || null,
      senderAddress: sender?.address?.trim().toLowerCase() || "unknown@invalid.local",
      subject: message.envelope?.subject?.trim().slice(0, 500) || "（无主题）",
      receivedAt: Number.isFinite(internalDate.getTime()) ? internalDate.getTime() : Date.now(),
      seen: message.flags?.has("\\Seen") ?? false,
      attachments: attachmentMetadata(message.bodyStructure),
    };
  }

  private async downloadReadableText(client: ImapFlow, message: FetchMessageObject): Promise<string> {
    const plainPart = findTextPart(message.bodyStructure, "text/plain");
    const htmlPart = plainPart ? null : findTextPart(message.bodyStructure, "text/html");
    const part = plainPart || htmlPart;
    if (!part) return "";
    const downloaded = await client.download(String(message.uid), part, { uid: true, maxBytes: 128 * 1024 });
    const bytes = await streamBuffer(downloaded.content);
    const decoded = decodeText(bytes, downloaded.meta.charset).replace(/\0/gu, "");
    return (htmlPart ? stripHtml(decoded) : decoded.trim()).slice(0, 12_000);
  }

  private async latestUid(client: ImapFlow): Promise<number> {
    if (!client.mailbox || client.mailbox.exists === 0) return 0;
    if (Number.isInteger(client.mailbox.uidNext) && client.mailbox.uidNext > 0) {
      return client.mailbox.uidNext - 1;
    }
    const latest = await client.fetchOne("*", { uid: true });
    if (!latest || !Number.isInteger(latest.uid)) throw new Error("IMAP server did not provide the latest message UID");
    return latest.uid;
  }

  private async withMailbox<T>(operation: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock(this.config.mailbox, { readOnly: true, acquireTimeout: 15_000 });
      try {
        return await operation(client);
      } finally {
        lock.release();
      }
    } finally {
      try { await client.logout(); } catch { client.close(); }
    }
  }
}

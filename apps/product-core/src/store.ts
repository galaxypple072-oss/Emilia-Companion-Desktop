import { createHash, randomUUID } from "node:crypto";
import type { MemoryCandidate, MemoryKind } from "./memory.ts";
import type { AffectAppraisal, AffectiveState } from "./affect.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type OutboxStatus = "pending" | "sending" | "sent" | "dead";

export interface OutboxMessage {
  id: string;
  recipientId: string;
  body: string;
  status: OutboxStatus;
  dueAt: number;
  nextAttemptAt: number;
  attempts: number;
  maxAttempts: number;
  dedupeKey: string | null;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export type ActionStatus = "pending_confirmation" | "approved" | "running" | "completed" | "failed" | "cancelled";

export interface CoreAction {
  id: string;
  kind: string;
  status: ActionStatus;
  summary: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
}

export interface LongTermMemory {
  id: string;
  kind: MemoryKind | "explicit";
  subject: string;
  key: string;
  content: string;
  importance: number;
  confidence: number;
  explicit: boolean;
  updatedAt: number;
}

export interface MemoryExtractionJob {
  id: string;
  sourceMessageId: string;
  text: string;
  attempts: number;
  maxAttempts: number;
}

export interface InterestSubscription {
  id: string;
  topic: string;
  createdAt: number;
  lastCheckedAt: number | null;
}

export type TaskStatus = "pending" | "completed" | "cancelled";
export type TaskPriority = "low" | "normal" | "high";

export interface TaskItem {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface IncomingEmailJob {
  id: string;
  senderName: string | null;
  senderAddress: string;
  subject: string;
  receivedAt: number;
  textExcerpt: string;
  attachments: Array<{ filename: string; contentType: string; size: number | null }>;
  forceNotify: boolean;
  attempts: number;
  maxAttempts: number;
}

export interface StyleFeedback {
  category: "questions" | "verbosity" | "service_tone" | "persona" | "positive";
  sentiment: "negative" | "positive";
  instruction: string;
  createdAt: number;
}

export interface Sticker {
  id: string;
  path: string;
  description: string;
  tags: string;
  nativePayload: { summary?: string; subType?: number } | null;
  timesUsed: number;
  lastUsedAt: number | null;
  createdAt: number;
}

interface OutboxRow {
  id: string;
  recipient_id: string;
  body: string;
  status: OutboxStatus;
  due_at: number;
  next_attempt_at: number;
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
}

function asOutboxMessage(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    recipientId: row.recipient_id,
    body: row.body,
    status: row.status,
    dueAt: row.due_at,
    nextAttemptAt: row.next_attempt_at,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    dedupeKey: row.dedupe_key,
  };
}

export class ProductStore {
  readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path, { timeout: 5000 });
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  enqueue(input: {
    recipientId: string;
    body: string;
    dueAt?: number;
    maxAttempts?: number;
    dedupeKey?: string;
  }): string {
    const body = input.body.trim();
    if (!body) throw new Error("Outbox message body must not be empty");
    if (body.length > 4000) throw new Error("Outbox messages are limited to 4000 characters");
    const now = Date.now();
    const id = randomUUID();
    this.database
      .prepare(`
        INSERT INTO outbox (
          id, recipient_id, body, status, due_at, next_attempt_at,
          attempts, max_attempts, dedupe_key, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.recipientId,
        body,
        input.dueAt ?? now,
        input.dueAt ?? now,
        input.maxAttempts ?? 5,
        input.dedupeKey ?? null,
        now,
        now,
      );
    return id;
  }

  addSticker(input: { id: string; path: string; description: string; tags: string; nativePayload?: { summary?: string; subType?: number } | null }, now = Date.now()): Sticker {
    this.database.prepare(`
      INSERT INTO stickers(id, path, description, tags, native_payload_json, times_used, last_used_at, created_at)
      VALUES (?, ?, ?, ?, ?, 0, NULL, ?)
    `).run(input.id, input.path, input.description, input.tags, input.nativePayload ? JSON.stringify(input.nativePayload) : null, now);
    return { ...input, nativePayload: input.nativePayload ?? null, timesUsed: 0, lastUsedAt: null, createdAt: now };
  }

  getSticker(id: string): Sticker | null {
    const row = this.database.prepare(`
      SELECT id, path, description, tags, native_payload_json, times_used, last_used_at, created_at FROM stickers WHERE id = ?
    `).get(id) as { id: string; path: string; description: string; tags: string; native_payload_json: string | null; times_used: number; last_used_at: number | null; created_at: number } | undefined;
    return row ? { id: row.id, path: row.path, description: row.description, tags: row.tags, nativePayload: row.native_payload_json ? JSON.parse(row.native_payload_json) as Sticker["nativePayload"] : null, timesUsed: row.times_used, lastUsedAt: row.last_used_at, createdAt: row.created_at } : null;
  }

  listStickers(limit = 30): Sticker[] {
    const rows = this.database.prepare(`
      SELECT id, path, description, tags, native_payload_json, times_used, last_used_at, created_at FROM stickers
      ORDER BY COALESCE(last_used_at, 0) ASC, created_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(100, limit))) as Array<{ id: string; path: string; description: string; tags: string; native_payload_json: string | null; times_used: number; last_used_at: number | null; created_at: number }>;
    return rows.map((row) => ({ id: row.id, path: row.path, description: row.description, tags: row.tags, nativePayload: row.native_payload_json ? JSON.parse(row.native_payload_json) as Sticker["nativePayload"] : null, timesUsed: row.times_used, lastUsedAt: row.last_used_at, createdAt: row.created_at }));
  }

  findSticker(query = ""): Sticker | null {
    const stickers = this.database.prepare(`
      SELECT id, path, description, tags, native_payload_json, times_used, last_used_at, created_at FROM stickers
      ORDER BY created_at DESC LIMIT 100
    `).all() as Array<{ id: string; path: string; description: string; tags: string; native_payload_json: string | null; times_used: number; last_used_at: number | null; created_at: number }>;
    if (stickers.length === 0) return null;
    const terms = query.replace(/(?:帮我|给我|发|来|一下|一个|个|张|刚才|刚刚|保存|表情包|表情)/gu, " ")
      .split(/\s+/u).map((term) => term.trim()).filter((term) => term.length >= 2);
    const matched = terms.length
      ? stickers.find((row) => terms.some((term) => `${row.description} ${row.tags}`.includes(term)))
      : undefined;
    const row = matched ?? stickers[0];
    return { id: row.id, path: row.path, description: row.description, tags: row.tags, nativePayload: row.native_payload_json ? JSON.parse(row.native_payload_json) as Sticker["nativePayload"] : null, timesUsed: row.times_used, lastUsedAt: row.last_used_at, createdAt: row.created_at };
  }

  enrichLatestSticker(note: string): Sticker | null {
    const latest = this.findSticker();
    const normalized = note.replace(/\s+/gu, " ").trim().slice(0, 300);
    if (!latest || !normalized) return latest;
    this.database.prepare("UPDATE stickers SET tags = substr(tags || ' ' || ?, 1, 1200) WHERE id = ?").run(normalized, latest.id);
    return this.getSticker(latest.id);
  }

  canUseSticker(now = Date.now(), cooldownMs = 10 * 60_000): boolean {
    const latest = this.database.prepare("SELECT MAX(last_used_at) AS value FROM stickers").get() as { value: number | null };
    return latest.value === null || now - latest.value >= cooldownMs;
  }

  markStickerUsed(id: string, now = Date.now()): void {
    this.database.prepare("UPDATE stickers SET times_used = times_used + 1, last_used_at = ? WHERE id = ?").run(now, id);
  }

  createAction(input: {
    kind: string;
    summary: string;
    payload: Record<string, unknown>;
    dedupeKey?: string;
    maxAttempts?: number;
  }): { id: string; created: boolean } {
    const now = Date.now();
    const id = randomUUID();
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO actions (
        id, kind, status, summary, payload_json, attempts, max_attempts,
        next_attempt_at, dedupe_key, created_at, updated_at
      ) VALUES (?, ?, 'pending_confirmation', ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.kind,
      input.summary.trim().slice(0, 500),
      JSON.stringify(input.payload),
      input.maxAttempts ?? 3,
      now,
      input.dedupeKey ?? null,
      now,
      now,
    );
    if (Number(result.changes) === 1) return { id, created: true };
    const existing = this.database.prepare("SELECT id FROM actions WHERE dedupe_key = ?").get(input.dedupeKey) as { id: string };
    return { id: existing.id, created: false };
  }

  upsertContact(alias: string, email: string, now = Date.now()): void {
    const normalizedAlias = alias.trim();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedAlias || normalizedAlias.length > 40 || /[\r\n|]/u.test(normalizedAlias)) throw new Error("联系人别名格式不正确");
    if (!/^\S+@\S+\.\S+$/u.test(normalizedEmail) || /[\r\n,;]/u.test(normalizedEmail)) throw new Error("邮箱格式不正确");
    this.database.prepare(`
      INSERT INTO contacts(alias, email, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at
    `).run(normalizedAlias, normalizedEmail, now, now);
  }

  removeContact(alias: string): boolean {
    return Number(this.database.prepare("DELETE FROM contacts WHERE alias = ? COLLATE NOCASE").run(alias.trim()).changes) === 1;
  }

  listContacts(): Array<{ alias: string; email: string }> {
    return this.database.prepare("SELECT alias, email FROM contacts ORDER BY alias COLLATE NOCASE")
      .all() as Array<{ alias: string; email: string }>;
  }

  resolveEmailRecipient(value: string): { label: string; email: string } {
    const normalized = value.trim();
    if (/^\S+@\S+\.\S+$/u.test(normalized) && !/[\r\n,;]/u.test(normalized)) {
      return { label: normalized, email: normalized.toLowerCase() };
    }
    const contact = this.database.prepare("SELECT alias, email FROM contacts WHERE alias = ? COLLATE NOCASE")
      .get(normalized) as { alias: string; email: string } | undefined;
    if (!contact) throw new Error(`找不到联系人“${normalized}”。请先用 /contact add 别名 邮箱 添加。`);
    return { label: contact.alias, email: contact.email };
  }

  listActions(limit = 10): Array<{ id: string; kind: string; status: ActionStatus; summary: string; createdAt: number }> {
    return (this.database.prepare(`
      SELECT id, kind, status, summary, created_at FROM actions
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(limit) as Array<{ id: string; kind: string; status: ActionStatus; summary: string; created_at: number }>)
      .map((row) => ({ id: row.id, kind: row.kind, status: row.status, summary: row.summary, createdAt: row.created_at }));
  }

  listActionAudit(limit = 20): Array<Record<string, unknown>> {
    return this.database.prepare(`
      SELECT id, kind, status, summary, attempts, max_attempts, external_id,
             last_error, created_at, confirmed_at, completed_at
      FROM actions ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
  }

  confirmAction(token: string, now = Date.now()): CoreAction {
    const action = this.resolveActionToken(token);
    if (action.status !== "pending_confirmation") throw new Error(`行动当前状态为 ${action.status}，不能确认`);
    this.database.prepare(`
      UPDATE actions SET status = 'approved', confirmed_at = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?
    `).run(now, now, now, action.id);
    return { ...action, status: "approved", nextAttemptAt: now };
  }

  cancelAction(token: string, now = Date.now()): CoreAction {
    const action = this.resolveActionToken(token);
    if (action.status !== "pending_confirmation" && action.status !== "approved") {
      throw new Error(`行动当前状态为 ${action.status}，不能取消`);
    }
    this.database.prepare("UPDATE actions SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, action.id);
    return { ...action, status: "cancelled" };
  }

  claimDueAction(now = Date.now()): CoreAction | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT id, kind, status, summary, payload_json, attempts, max_attempts, next_attempt_at
        FROM actions WHERE status = 'approved' AND next_attempt_at <= ?
        ORDER BY confirmed_at ASC LIMIT 1
      `).get(now) as ActionRow | undefined;
      if (!row) {
        this.database.exec("COMMIT");
        return null;
      }
      this.database.prepare("UPDATE actions SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .run(now, row.id);
      this.database.exec("COMMIT");
      return asCoreAction({ ...row, status: "running", attempts: row.attempts + 1 });
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markActionCompleted(id: string, externalId: string | null, now = Date.now()): void {
    this.database.prepare(`
      UPDATE actions SET status = 'completed', completed_at = ?, updated_at = ?, external_id = ?, last_error = NULL
      WHERE id = ? AND status = 'running'
    `).run(now, now, externalId, id);
  }

  markActionFailed(action: CoreAction, error: string, now = Date.now()): ActionStatus {
    const terminal = action.attempts >= action.maxAttempts;
    const status: ActionStatus = terminal ? "failed" : "approved";
    const nextAttemptAt = now + Math.min(300_000, 5_000 * 2 ** Math.max(0, action.attempts - 1));
    this.database.prepare(`
      UPDATE actions SET status = ?, next_attempt_at = ?, updated_at = ?, last_error = ?
      WHERE id = ? AND status = 'running'
    `).run(status, nextAttemptAt, now, error.slice(0, 1000), action.id);
    return status;
  }

  recoverInterruptedActions(now = Date.now()): number {
    const result = this.database.prepare(`
      UPDATE actions SET status = 'approved', next_attempt_at = ?, updated_at = ?,
        last_error = 'Recovered after process interruption' WHERE status = 'running'
    `).run(now, now);
    return Number(result.changes);
  }

  recoverInterrupted(now = Date.now()): number {
    const result = this.database
      .prepare(`
        UPDATE outbox
        SET status = 'pending', next_attempt_at = ?, updated_at = ?,
            last_error = 'Recovered after process interruption'
        WHERE status = 'sending'
      `)
      .run(now, now);
    return Number(result.changes);
  }

  claimDue(now = Date.now()): OutboxMessage | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare(`
          SELECT id, recipient_id, body, status, due_at, next_attempt_at,
                 attempts, max_attempts, dedupe_key
          FROM outbox
          WHERE status = 'pending' AND due_at <= ? AND next_attempt_at <= ?
          ORDER BY due_at ASC, created_at ASC
          LIMIT 1
        `)
        .get(now, now) as OutboxRow | undefined;
      if (!row) {
        this.database.exec("COMMIT");
        return null;
      }
      this.database
        .prepare("UPDATE outbox SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .run(now, row.id);
      this.database.exec("COMMIT");
      return asOutboxMessage({ ...row, status: "sending", attempts: row.attempts + 1 });
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markSent(id: string, externalMessageId: string | null, now = Date.now()): void {
    this.database
      .prepare(`
        UPDATE outbox
        SET status = 'sent', sent_at = ?, updated_at = ?, external_message_id = ?, last_error = NULL
        WHERE id = ? AND status = 'sending'
      `)
      .run(now, now, externalMessageId, id);
  }

  markFailed(message: OutboxMessage, error: string, now = Date.now()): OutboxStatus {
    const dead = message.attempts >= message.maxAttempts;
    const nextAttemptAt = now + Math.min(300_000, 5_000 * 2 ** Math.max(0, message.attempts - 1));
    const status: OutboxStatus = dead ? "dead" : "pending";
    this.database
      .prepare(`
        UPDATE outbox
        SET status = ?, next_attempt_at = ?, updated_at = ?, last_error = ?
        WHERE id = ? AND status = 'sending'
      `)
      .run(status, nextAttemptAt, now, error.slice(0, 1000), message.id);
    return status;
  }

  recordInbound(input: {
    channel: string;
    externalMessageId: string;
    senderId: string;
    body: string;
    receivedAt: number;
    conversationVisible?: boolean;
  }): boolean {
    const result = this.database
      .prepare(`
        INSERT OR IGNORE INTO inbound_messages (
          id, channel, external_message_id, sender_id, body, received_at, created_at, conversation_visible
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        input.channel,
        input.externalMessageId,
        input.senderId,
        input.body,
        input.receivedAt,
        Date.now(),
        input.conversationVisible === false ? 0 : 1,
      );
    return Number(result.changes) === 1;
  }

  recordCompanionMessage(input: {
    ownerId: string;
    clientId: string;
    externalMessageId: string;
    role: "user" | "assistant";
    content: string;
    occurredAt?: number;
  }): boolean {
    const content = input.content.trim();
    if (!content) throw new Error("Companion message content must not be empty");
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO companion_messages (
        id, owner_id, client_id, external_message_id, role, content, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.ownerId,
      input.clientId.slice(0, 120),
      input.externalMessageId.slice(0, 160),
      input.role,
      content.slice(0, 4000),
      input.occurredAt ?? Date.now(),
      Date.now(),
    );
    return Number(result.changes) === 1;
  }

  loadAffectiveState(ownerId: string): AffectiveState | null {
    const row = this.database.prepare("SELECT state_json FROM affective_states WHERE owner_id = ?").get(ownerId) as { state_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.state_json) as AffectiveState;
    } catch {
      return null;
    }
  }

  applyAffectEvent(input: {
    ownerId: string;
    sourceMessageId: string;
    event: AffectAppraisal;
    before: AffectiveState;
    after: AffectiveState;
    now?: number;
  }): boolean {
    const now = input.now ?? Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO affect_events (
          id, owner_id, source_message_id, emotion, reason, appraisal_json,
          before_json, after_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), input.ownerId, input.sourceMessageId, input.event.emotion,
        input.event.reason.slice(0, 200), JSON.stringify(input.event),
        JSON.stringify(input.before), JSON.stringify(input.after), now,
      );
      if (Number(result.changes) === 1) {
        this.database.prepare(`
          INSERT INTO affective_states(owner_id, state_json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(owner_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
        `).run(input.ownerId, JSON.stringify(input.after), now);
      }
      this.database.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listAffectEvents(ownerId: string, limit = 20): Array<{ emotion: string; reason: string; createdAt: number }> {
    const rows = this.database.prepare(`
      SELECT emotion, reason, created_at FROM affect_events
      WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(ownerId, Math.max(1, Math.min(100, limit))) as Array<{ emotion: string; reason: string; created_at: number }>;
    return rows.map((row) => ({ emotion: row.emotion, reason: row.reason, createdAt: row.created_at }));
  }

  recordImageAnalysis(channel: string, externalMessageId: string, analysis: string): void {
    const normalized = analysis.trim();
    if (!normalized) throw new Error("Image analysis must not be empty");
    this.database.prepare(`
      INSERT INTO image_analyses(channel, external_message_id, analysis, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(channel, external_message_id) DO UPDATE SET analysis = excluded.analysis
    `).run(channel, externalMessageId, normalized.slice(0, 8000), Date.now());
  }

  rememberExplicit(content: string, sourceMessageId: string | null = null, now = Date.now()): LongTermMemory {
    const normalized = content.trim();
    if (!normalized || normalized.length > 500) throw new Error("记忆内容应为 1 到 500 个字符");
    const key = createHash("sha256").update(normalized.toLowerCase()).digest("hex").slice(0, 24);
    return this.upsertMemory({
      kind: "explicit",
      subject: "用户",
      key,
      content: normalized,
      importance: 5,
      confidence: 1,
      explicit: true,
      sourceMessageId,
      now,
    });
  }

  upsertExtractedMemory(candidate: MemoryCandidate, sourceMessageId: string, now = Date.now()): LongTermMemory {
    return this.upsertMemory({ ...candidate, explicit: false, sourceMessageId, now });
  }

  listMemories(limit = 20): LongTermMemory[] {
    const rows = this.database.prepare(`
      SELECT id, kind, subject, memory_key, content, importance, confidence, explicit, updated_at
      FROM memories WHERE status = 'active'
      ORDER BY explicit DESC, importance DESC, updated_at DESC LIMIT ?
    `).all(limit) as MemoryRow[];
    return rows.map(asLongTermMemory);
  }

  forgetMemory(token: string, now = Date.now()): LongTermMemory {
    const normalized = token.trim().toLowerCase();
    if (!/^[0-9a-f-]{6,36}$/u.test(normalized)) throw new Error("记忆编号格式不正确");
    const rows = this.database.prepare(`
      SELECT id, kind, subject, memory_key, content, importance, confidence, explicit, updated_at
      FROM memories WHERE status = 'active' AND lower(id) LIKE ? LIMIT 2
    `).all(`${normalized}%`) as MemoryRow[];
    if (rows.length === 0) throw new Error("找不到这条记忆");
    if (rows.length > 1) throw new Error("记忆编号不够明确，请输入更多字符");
    this.database.prepare("UPDATE memories SET status = 'forgotten', updated_at = ? WHERE id = ?").run(now, rows[0].id);
    return asLongTermMemory(rows[0]);
  }

  retrieveMemories(query: string, limit = 8, now = Date.now()): LongTermMemory[] {
    const candidates = this.listMemories(500);
    if (candidates.length === 0) return [];
    const queryTokens = memoryTokens(query);
    const scored = candidates.map((memory) => {
      const haystack = `${memory.subject} ${memory.key} ${memory.content}`.toLowerCase();
      const overlap = queryTokens.reduce((sum, token) => sum + (haystack.includes(token) ? (token.length > 1 ? 2 : 1) : 0), 0);
      const stableBonus = memory.explicit ? 1.5 : memory.kind === "person" || memory.kind === "relationship" ? 0.75 : 0;
      const score = overlap * 3 + memory.importance + stableBonus;
      return { memory, score, overlap };
    }).filter((entry) => entry.overlap > 0);
    scored.sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt);
    const selected = scored.slice(0, limit).map((entry) => entry.memory);
    // Explicit "remember this" facts are allowed one fallback slot because a
    // lexical query can miss a semantically related fact (for example dinner
    // and a food allergy). Automatically extracted memories must match the
    // current turn instead of being injected merely for having importance 3+.
    if (selected.length < limit) {
      const explicitFallback = candidates.find((memory) => memory.explicit && memory.importance >= 4
        && !selected.some((item) => item.id === memory.id));
      if (explicitFallback) selected.push(explicitFallback);
    }
    if (selected.length) {
      const placeholders = selected.map(() => "?").join(",");
      this.database.prepare(`UPDATE memories SET last_used_at = ? WHERE id IN (${placeholders})`).run(now, ...selected.map((memory) => memory.id));
    }
    return selected;
  }

  enqueueMemoryExtraction(sourceMessageId: string, text: string, now = Date.now()): boolean {
    const normalized = text.trim();
    if (!normalized || normalized.startsWith("/") || normalized.length > 6000) return false;
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO memory_extraction_jobs (
        id, source_message_id, text, status, attempts, max_attempts, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 0, 3, ?, ?, ?)
    `).run(randomUUID(), sourceMessageId, normalized, now, now, now);
    return Number(result.changes) === 1;
  }

  claimMemoryExtraction(now = Date.now()): MemoryExtractionJob | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT id, source_message_id, text, attempts, max_attempts
        FROM memory_extraction_jobs
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY created_at ASC LIMIT 1
      `).get(now) as MemoryJobRow | undefined;
      if (!row) {
        this.database.exec("COMMIT");
        return null;
      }
      this.database.prepare("UPDATE memory_extraction_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .run(now, row.id);
      this.database.exec("COMMIT");
      return { id: row.id, sourceMessageId: row.source_message_id, text: row.text, attempts: row.attempts + 1, maxAttempts: row.max_attempts };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  completeMemoryExtraction(job: MemoryExtractionJob, memories: MemoryCandidate[], now = Date.now()): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of memories) this.upsertExtractedMemory(candidate, job.sourceMessageId, now);
      this.database.prepare("UPDATE memory_extraction_jobs SET status = 'completed', updated_at = ?, last_error = NULL WHERE id = ?")
        .run(now, job.id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  failMemoryExtraction(job: MemoryExtractionJob, error: string, now = Date.now()): "pending" | "dead" {
    const status = job.attempts >= job.maxAttempts ? "dead" : "pending";
    const nextAttempt = now + Math.min(300_000, 10_000 * 2 ** Math.max(0, job.attempts - 1));
    this.database.prepare(`
      UPDATE memory_extraction_jobs SET status = ?, next_attempt_at = ?, updated_at = ?, last_error = ? WHERE id = ?
    `).run(status, nextAttempt, now, error.slice(0, 1000), job.id);
    return status;
  }

  recoverMemoryExtractions(now = Date.now()): number {
    return Number(this.database.prepare(`
      UPDATE memory_extraction_jobs SET status = 'pending', next_attempt_at = ?, updated_at = ?,
        last_error = 'Recovered after process interruption' WHERE status = 'running'
    `).run(now, now).changes);
  }

  summary(now = Date.now()): Record<string, unknown> {
    const counts = this.database
      .prepare("SELECT status, COUNT(*) AS count FROM outbox GROUP BY status ORDER BY status")
      .all() as Array<{ status: string; count: number }>;
    const inbound = this.database.prepare("SELECT COUNT(*) AS count FROM inbound_messages").get() as {
      count: number;
    };
    const actionCounts = this.database
      .prepare("SELECT status, COUNT(*) AS count FROM actions GROUP BY status ORDER BY status")
      .all() as Array<{ status: string; count: number }>;
    const memories = this.database.prepare("SELECT COUNT(*) AS count FROM memories WHERE status = 'active'").get() as { count: number };
    const pendingTasks = this.database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'pending'").get() as { count: number };
    const emailInbox = this.database.prepare("SELECT status, COUNT(*) AS count FROM incoming_emails GROUP BY status").all() as Array<{ status: string; count: number }>;
    const next = this.database
      .prepare("SELECT due_at FROM outbox WHERE status = 'pending' ORDER BY due_at ASC LIMIT 1")
      .get() as { due_at: number } | undefined;
    return {
      outbox: Object.fromEntries(counts.map((row) => [row.status, row.count])),
      inbound: inbound.count,
      actions: Object.fromEntries(actionCounts.map((row) => [row.status, row.count])),
      memories: memories.count,
      pending_tasks: pendingTasks.count,
      incoming_emails: Object.fromEntries(emailInbox.map((row) => [row.status, row.count])),
      next_due_at: next ? new Date(next.due_at).toISOString() : null,
      now: new Date(now).toISOString(),
    };
  }

  listInbound(limit = 20): Array<Record<string, unknown>> {
    return this.database
      .prepare(`
        SELECT channel, external_message_id, sender_id, body, received_at
        FROM inbound_messages ORDER BY received_at DESC LIMIT ?
      `)
      .all(limit) as Array<Record<string, unknown>>;
  }

  recentConversation(ownerQQ: string, limit = 20, since = 0): ConversationMessage[] {
    const rows = this.database
      .prepare(`
        SELECT role, content, occurred_at FROM (
          SELECT 'user' AS role, COALESCE(a.analysis, i.body) AS content,
            CASE
              WHEN a.analysis IS NOT NULL THEN MAX(i.received_at, a.created_at)
              ELSE i.received_at
            END AS occurred_at
          FROM inbound_messages i
          LEFT JOIN image_analyses a
            ON a.channel = i.channel AND a.external_message_id = i.external_message_id
          WHERE i.sender_id = ? AND i.received_at >= ? AND i.conversation_visible = 1
          UNION ALL
          SELECT 'assistant' AS role, body AS content, sent_at AS occurred_at
          FROM outbox WHERE recipient_id = ? AND status = 'sent' AND sent_at IS NOT NULL AND sent_at >= ?
          UNION ALL
          SELECT role, content, occurred_at
          FROM companion_messages WHERE owner_id = ? AND occurred_at >= ?
        )
        ORDER BY occurred_at DESC
        LIMIT ?
      `)
      .all(ownerQQ, since, ownerQQ, since, ownerQQ, since, limit) as Array<ConversationMessage & { occurred_at: number }>;
    return rows.reverse().map(({ role, content }) => ({ role, content }));
  }

  recentAssistantMessages(ownerQQ: string, limit = 4, since = 0): string[] {
    const rows = this.database.prepare(`
      SELECT body FROM outbox
      WHERE recipient_id = ? AND status = 'sent' AND sent_at IS NOT NULL AND sent_at >= ?
      ORDER BY sent_at DESC, rowid DESC LIMIT ?
    `).all(ownerQQ, since, limit) as Array<{ body: string }>;
    return rows.reverse().map((row) => row.body);
  }

  latestAssistantConversationAt(ownerQQ: string, since = 0): number | null {
    const row = this.database.prepare(`
      SELECT MAX(occurred_at) AS occurred_at FROM (
        SELECT sent_at AS occurred_at FROM outbox
        WHERE recipient_id = ? AND status = 'sent' AND sent_at IS NOT NULL AND sent_at >= ?
        UNION ALL
        SELECT occurred_at FROM companion_messages
        WHERE owner_id = ? AND role = 'assistant' AND occurred_at >= ?
      )
    `).get(ownerQQ, since, ownerQQ, since) as { occurred_at: number | null };
    return typeof row.occurred_at === "number" ? row.occurred_at : null;
  }

  ensurePersonaEpoch(version: string, now = Date.now()): number {
    const currentVersion = this.getState("persona_version");
    const currentEpoch = Number(this.getState("persona_epoch_at"));
    if (currentVersion === version && Number.isFinite(currentEpoch) && currentEpoch > 0) return currentEpoch;
    this.setState("persona_version", version, now);
    this.setState("persona_epoch_at", String(now), now);
    return now;
  }

  recordStyleFeedback(input: {
    category: StyleFeedback["category"];
    sentiment: StyleFeedback["sentiment"];
    instruction: string;
    sourceMessageId: string;
    targetOutboxId?: string | null;
    now?: number;
  }): boolean {
    const now = input.now ?? Date.now();
    const instruction = input.instruction.replace(/\s+/gu, " ").trim().slice(0, 500);
    if (!instruction) return false;
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO style_feedback (
        id, category, sentiment, instruction, source_message_id, target_outbox_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), input.category, input.sentiment, instruction, input.sourceMessageId, input.targetOutboxId ?? null, now);
    return Number(result.changes) === 1;
  }

  listStyleFeedback(limit = 20): StyleFeedback[] {
    const rows = this.database.prepare(`
      SELECT category, sentiment, instruction, created_at FROM style_feedback
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(limit) as Array<{ category: StyleFeedback["category"]; sentiment: StyleFeedback["sentiment"]; instruction: string; created_at: number }>;
    return rows.map((row) => ({ category: row.category, sentiment: row.sentiment, instruction: row.instruction, createdAt: row.created_at }));
  }

  stylePreferenceContext(): string {
    const feedback = this.listStyleFeedback(30);
    if (feedback.length === 0) return "";
    const latestByCategory = new Map<string, StyleFeedback>();
    for (const item of feedback) if (!latestByCategory.has(item.category)) latestByCategory.set(item.category, item);
    return `用户明确表达过的聊天偏好（优先遵守）：\n${[...latestByCategory.values()].map((item) => `- ${item.instruction}`).join("\n")}`;
  }

  latestAssistantOutboxId(ownerQQ: string): string | null {
    const row = this.database.prepare(`
      SELECT id FROM outbox WHERE recipient_id = ? AND status = 'sent'
      ORDER BY sent_at DESC, rowid DESC LIMIT 1
    `).get(ownerQQ) as { id: string } | undefined;
    return row?.id ?? null;
  }

  recordDialogueAudit(input: {
    sourceMessageId: string | null;
    intent: string;
    move: string;
    questionBudget: number;
    maxChars: number;
    rewritten: boolean;
    violations: string[];
    finalText: string;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.database.prepare(`
      INSERT INTO dialogue_audit (
        id, source_message_id, intent, move, question_budget, max_chars,
        rewritten, violations_json, final_length, final_question_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), input.sourceMessageId, input.intent.slice(0, 40), input.move.slice(0, 40),
      input.questionBudget, input.maxChars, input.rewritten ? 1 : 0,
      JSON.stringify(input.violations.slice(0, 20)), input.finalText.length,
      input.finalText.match(/[?？]/gu)?.length ?? 0, now,
    );
  }

  dialoguePolicySummary(limit = 50): Record<string, unknown> {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS turns,
        COALESCE(SUM(rewritten), 0) AS rewritten,
        COALESCE(SUM(CASE WHEN final_question_count > 0 THEN 1 ELSE 0 END), 0) AS turns_with_questions,
        COALESCE(ROUND(AVG(final_length), 1), 0) AS average_length
      FROM (SELECT rewritten, final_question_count, final_length FROM dialogue_audit ORDER BY created_at DESC, rowid DESC LIMIT ?)
    `).get(limit) as { turns: number; rewritten: number; turns_with_questions: number; average_length: number };
    return {
      turns: row.turns,
      rewritten: row.rewritten,
      turns_with_questions: row.turns_with_questions,
      average_length: row.average_length,
    };
  }

  latestInboundExternalMessageId(ownerQQ: string): string | null {
    const row = this.database.prepare(`
      SELECT external_message_id FROM inbound_messages
      WHERE sender_id = ? AND conversation_visible = 1 ORDER BY received_at DESC, rowid DESC LIMIT 1
    `).get(ownerQQ) as { external_message_id: string } | undefined;
    return row?.external_message_id ?? null;
  }

  latestInboundAt(ownerQQ: string): number | null {
    const row = this.database.prepare(`
      SELECT MAX(received_at) AS timestamp FROM inbound_messages WHERE sender_id = ?
    `).get(ownerQQ) as { timestamp: number | null };
    return row.timestamp;
  }

  latestProactiveAt(): number | null {
    const row = this.database.prepare(`
      SELECT MAX(COALESCE(sent_at, created_at)) AS timestamp
      FROM outbox WHERE dedupe_key LIKE 'proactive:%' AND status != 'dead'
    `).get() as { timestamp: number | null };
    return row.timestamp;
  }

  countProactiveForDate(localDate: string): number {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(localDate)) throw new Error("Invalid proactive local date");
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM outbox
      WHERE dedupe_key LIKE ? AND status != 'dead'
    `).get(`proactive:${localDate}:%`) as { count: number };
    return row.count;
  }

  addInterest(topic: string, now = Date.now()): InterestSubscription {
    const normalized = topic.replace(/\s+/gu, " ").trim();
    if (normalized.length < 2 || normalized.length > 60) throw new Error("兴趣主题应为 2 到 60 个字符");
    if (this.listInterests(100).length >= 20) throw new Error("最多订阅 20 个兴趣主题");
    const id = randomUUID();
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO interests(id, topic, enabled, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
    `).run(id, normalized, now, now);
    if (Number(result.changes) === 0) throw new Error("这个兴趣主题已经订阅了");
    return { id, topic: normalized, createdAt: now, lastCheckedAt: null };
  }

  listInterests(limit = 20): InterestSubscription[] {
    const rows = this.database.prepare(`
      SELECT id, topic, created_at, last_checked_at FROM interests
      WHERE enabled = 1 ORDER BY created_at ASC LIMIT ?
    `).all(limit) as Array<{ id: string; topic: string; created_at: number; last_checked_at: number | null }>;
    return rows.map((row) => ({ id: row.id, topic: row.topic, createdAt: row.created_at, lastCheckedAt: row.last_checked_at }));
  }

  removeInterest(token: string, now = Date.now()): InterestSubscription {
    const normalized = token.trim().toLowerCase();
    if (!/^[0-9a-f-]{6,36}$/u.test(normalized)) throw new Error("兴趣编号格式不正确");
    const rows = this.database.prepare(`
      SELECT id, topic, created_at, last_checked_at FROM interests
      WHERE enabled = 1 AND lower(id) LIKE ? LIMIT 2
    `).all(`${normalized}%`) as Array<{ id: string; topic: string; created_at: number; last_checked_at: number | null }>;
    if (rows.length === 0) throw new Error("找不到这个兴趣主题");
    if (rows.length > 1) throw new Error("兴趣编号不够明确，请输入更多字符");
    this.database.prepare("UPDATE interests SET enabled = 0, updated_at = ? WHERE id = ?").run(now, rows[0].id);
    return { id: rows[0].id, topic: rows[0].topic, createdAt: rows[0].created_at, lastCheckedAt: rows[0].last_checked_at };
  }

  nextInterestForCheck(): InterestSubscription | null {
    const row = this.database.prepare(`
      SELECT id, topic, created_at, last_checked_at FROM interests
      WHERE enabled = 1 ORDER BY last_checked_at IS NOT NULL, last_checked_at ASC, created_at ASC LIMIT 1
    `).get() as { id: string; topic: string; created_at: number; last_checked_at: number | null } | undefined;
    return row ? { id: row.id, topic: row.topic, createdAt: row.created_at, lastCheckedAt: row.last_checked_at } : null;
  }

  markInterestChecked(id: string, now = Date.now()): void {
    this.database.prepare("UPDATE interests SET last_checked_at = ?, updated_at = ? WHERE id = ? AND enabled = 1").run(now, now, id);
  }

  hasOutboxDedupeKey(key: string): boolean {
    return this.database.prepare("SELECT 1 FROM outbox WHERE dedupe_key = ? LIMIT 1").get(key) !== undefined;
  }

  countOutboxByPrefixSince(prefix: string, since: number): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM outbox
      WHERE dedupe_key LIKE ? AND created_at >= ? AND status != 'dead'
    `).get(`${prefix}%`, since) as { count: number };
    return row.count;
  }

  createTask(input: {
    title: string;
    notes?: string;
    dueAt?: number | null;
    priority?: TaskPriority;
    sourceKey?: string;
    now?: number;
  }): { task: TaskItem; created: boolean } {
    const now = input.now ?? Date.now();
    const title = input.title.replace(/\s+/gu, " ").trim();
    const notes = input.notes?.trim() || null;
    const priority = input.priority ?? "normal";
    if (!title || title.length > 300) throw new Error("任务标题应为 1 到 300 个字符");
    if (notes && notes.length > 2000) throw new Error("任务备注不能超过 2000 个字符");
    if (!(["low", "normal", "high"] as string[]).includes(priority)) throw new Error("任务优先级无效");
    if (input.dueAt !== undefined && input.dueAt !== null && (!Number.isFinite(input.dueAt) || input.dueAt > now + 5 * 365 * 86_400_000)) {
      throw new Error("任务截止时间无效或过远");
    }
    const sourceKey = input.sourceKey?.trim().slice(0, 200) || null;
    const id = randomUUID();
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO tasks (
        id, title, notes, status, priority, due_at, notification_stage,
        source_key, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, 'none', ?, ?, ?)
    `).run(id, title, notes, priority, input.dueAt ?? null, sourceKey, now, now);
    const task = sourceKey && Number(result.changes) === 0
      ? this.database.prepare("SELECT * FROM tasks WHERE source_key = ?").get(sourceKey) as TaskRow
      : this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
    return { task: asTaskItem(task), created: Number(result.changes) === 1 };
  }

  listTasks(status: TaskStatus = "pending", limit = 20): TaskItem[] {
    const rows = this.database.prepare(`
      SELECT * FROM tasks WHERE status = ?
      ORDER BY due_at IS NULL, due_at ASC,
        CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        created_at ASC LIMIT ?
    `).all(status, limit) as TaskRow[];
    return rows.map(asTaskItem);
  }

  completeTask(token: string, now = Date.now()): TaskItem {
    const task = this.resolveTaskToken(token);
    if (task.status !== "pending") throw new Error("这个任务已经不是待办状态");
    this.database.prepare("UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, task.id);
    return { ...task, status: "completed", updatedAt: now };
  }

  cancelTask(token: string, now = Date.now()): TaskItem {
    const task = this.resolveTaskToken(token);
    if (task.status !== "pending") throw new Error("这个任务已经不是待办状态");
    this.database.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, task.id);
    return { ...task, status: "cancelled", updatedAt: now };
  }

  snoozeTask(token: string, dueAt: number, now = Date.now()): TaskItem {
    const task = this.resolveTaskToken(token);
    if (task.status !== "pending") throw new Error("只能推迟待办任务");
    if (!Number.isFinite(dueAt) || dueAt <= now || dueAt > now + 5 * 365 * 86_400_000) throw new Error("新的截止时间无效");
    this.database.prepare(`
      UPDATE tasks SET due_at = ?, notification_stage = 'none', updated_at = ? WHERE id = ?
    `).run(dueAt, now, task.id);
    return { ...task, dueAt, updatedAt: now };
  }

  queueNextTaskNotification(recipientId: string, now = Date.now()): { task: TaskItem; stage: string } | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT * FROM tasks WHERE status = 'pending' AND due_at IS NOT NULL AND (
          (notification_stage = 'none' AND due_at <= ?) OR
          (notification_stage = 'upcoming' AND due_at <= ?) OR
          (notification_stage = 'due' AND due_at + 10800000 <= ?)
        ) ORDER BY due_at ASC LIMIT 1
      `).get(now + 3_600_000, now, now) as TaskRow | undefined;
      if (!row || row.due_at === null) {
        this.database.exec("COMMIT");
        return null;
      }
      let stage: "upcoming" | "due" | "overdue";
      if (row.notification_stage === "none") {
        stage = row.due_at <= now - 10_800_000 ? "overdue" : row.due_at <= now ? "due" : "upcoming";
      } else if (row.notification_stage === "upcoming") {
        stage = "due";
      } else {
        stage = "overdue";
      }
      const dueText = new Date(row.due_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
      const token = row.id.slice(0, 8);
      const body = stage === "upcoming"
        ? `任务快到时间了：${row.title}\n截止：${dueText}\n完成后发 /done ${token}`
        : stage === "due"
          ? `任务到时间了：${row.title}\n完成后发 /done ${token}，需要推迟可以发 /snooze ${token} 1h`
          : `这项任务还没有标记完成：${row.title}\n如果已经完成，发 /done ${token}`;
      const messageId = randomUUID();
      this.database.prepare(`
        INSERT OR IGNORE INTO outbox (
          id, recipient_id, body, status, due_at, next_attempt_at,
          attempts, max_attempts, dedupe_key, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, 0, 5, ?, ?, ?)
      `).run(messageId, recipientId, body, now, now, `task:${row.id}:${stage}`, now, now);
      this.database.prepare("UPDATE tasks SET notification_stage = ?, updated_at = ? WHERE id = ?").run(stage, now, row.id);
      this.database.exec("COMMIT");
      return { task: asTaskItem({ ...row, notification_stage: stage, updated_at: now }), stage };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  ingestIncomingEmail(input: {
    account: string; mailbox: string; uidValidity: string; uid: number; messageId: string | null;
    senderName: string | null; senderAddress: string; subject: string; receivedAt: number;
    textExcerpt: string; attachments: IncomingEmailJob["attachments"]; forceNotify: boolean; now?: number;
  }): boolean {
    const now = input.now ?? Date.now();
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO incoming_emails (
        id, account, mailbox, uid_validity, uid, message_id, sender_name, sender_address,
        subject, received_at, text_excerpt, attachments_json, force_notify, status,
        attempts, max_attempts, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 3, ?, ?, ?)
    `).run(
      randomUUID(), input.account.toLowerCase(), input.mailbox, input.uidValidity, input.uid,
      input.messageId, input.senderName, input.senderAddress.toLowerCase(), input.subject,
      input.receivedAt, input.textExcerpt.slice(0, 12_000), JSON.stringify(input.attachments.slice(0, 30)),
      input.forceNotify ? 1 : 0, now, now, now,
    );
    return Number(result.changes) === 1;
  }

  claimIncomingEmail(now = Date.now()): IncomingEmailJob | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT id, sender_name, sender_address, subject, received_at, text_excerpt,
          attachments_json, force_notify, attempts, max_attempts
        FROM incoming_emails WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY received_at ASC LIMIT 1
      `).get(now) as IncomingEmailRow | undefined;
      if (!row) {
        this.database.exec("COMMIT");
        return null;
      }
      this.database.prepare("UPDATE incoming_emails SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now, row.id);
      this.database.exec("COMMIT");
      return asIncomingEmailJob({ ...row, attempts: row.attempts + 1 });
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  completeIncomingEmail(job: IncomingEmailJob, input: {
    notify: boolean; triage: Record<string, unknown>; notificationBody?: string; recipientId?: string;
  }, now = Date.now()): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (input.notify) {
        if (!input.notificationBody || !input.recipientId) throw new Error("Email notification details are required");
        this.database.prepare(`
          INSERT OR IGNORE INTO outbox (
            id, recipient_id, body, status, due_at, next_attempt_at,
            attempts, max_attempts, dedupe_key, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', ?, ?, 0, 5, ?, ?, ?)
        `).run(randomUUID(), input.recipientId, input.notificationBody.trim().slice(0, 4000), now, now, `incoming-email:${job.id}`, now, now);
      }
      this.database.prepare(`
        UPDATE incoming_emails SET status = ?, triage_json = ?, updated_at = ?, processed_at = ?, last_error = NULL
        WHERE id = ? AND status = 'processing'
      `).run(input.notify ? "notified" : "ignored", JSON.stringify(input.triage), now, now, job.id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  failIncomingEmail(job: IncomingEmailJob, error: string, now = Date.now()): "pending" | "dead" {
    const status = job.attempts >= job.maxAttempts ? "dead" : "pending";
    const nextAttemptAt = now + Math.min(300_000, 15_000 * 2 ** Math.max(0, job.attempts - 1));
    this.database.prepare(`
      UPDATE incoming_emails SET status = ?, next_attempt_at = ?, updated_at = ?, last_error = ?
      WHERE id = ? AND status = 'processing'
    `).run(status, nextAttemptAt, now, error.slice(0, 1000), job.id);
    return status;
  }

  recoverIncomingEmails(now = Date.now()): number {
    return Number(this.database.prepare(`
      UPDATE incoming_emails SET status = 'pending', next_attempt_at = ?, updated_at = ?,
        last_error = 'Recovered after process interruption' WHERE status = 'processing'
    `).run(now, now).changes);
  }

  getState(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM core_state WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string, now = Date.now()): void {
    this.database
      .prepare(`
        INSERT INTO core_state(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(key, value, now);
  }

  deleteState(key: string): boolean {
    return Number(this.database.prepare("DELETE FROM core_state WHERE key = ?").run(key).changes) === 1;
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        recipient_id TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'dead')),
        due_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        dedupe_key TEXT UNIQUE,
        external_message_id TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        sent_at INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS outbox_due_idx
        ON outbox(status, due_at, next_attempt_at);

      CREATE TABLE IF NOT EXISTS inbound_messages (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        external_message_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        body TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        conversation_visible INTEGER NOT NULL DEFAULT 1 CHECK (conversation_visible IN (0, 1)),
        UNIQUE(channel, external_message_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS image_analyses (
        channel TEXT NOT NULL,
        external_message_id TEXT NOT NULL,
        analysis TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(channel, external_message_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS companion_messages (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        external_message_id TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS companion_messages_owner_idx
        ON companion_messages(owner_id, occurred_at);

      CREATE TABLE IF NOT EXISTS affective_states (
        owner_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS affect_events (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        emotion TEXT NOT NULL,
        reason TEXT NOT NULL,
        appraisal_json TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(owner_id, source_message_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS affect_events_owner_idx
        ON affect_events(owner_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS stickers (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        tags TEXT NOT NULL,
        native_payload_json TEXT,
        times_used INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS stickers_usage_idx
        ON stickers(last_used_at, created_at);

      CREATE TABLE IF NOT EXISTS core_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending_confirmation', 'approved', 'running', 'completed', 'failed', 'cancelled')),
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_attempt_at INTEGER NOT NULL,
        dedupe_key TEXT UNIQUE,
        external_id TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        confirmed_at INTEGER,
        completed_at INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS actions_due_idx ON actions(status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS contacts (
        alias TEXT PRIMARY KEY COLLATE NOCASE,
        email TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        identity_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
        confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        explicit INTEGER NOT NULL CHECK (explicit IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('active', 'forgotten')),
        source_message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memories_active_idx ON memories(status, importance, updated_at);

      CREATE TABLE IF NOT EXISTS memory_extraction_jobs (
        id TEXT PRIMARY KEY,
        source_message_id TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS interests (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL COLLATE NOCASE UNIQUE,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_checked_at INTEGER
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled')),
        priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
        due_at INTEGER,
        notification_stage TEXT NOT NULL CHECK (notification_stage IN ('none', 'upcoming', 'due', 'overdue')),
        source_key TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks(status, due_at, notification_stage);

      CREATE TABLE IF NOT EXISTS incoming_emails (
        id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        mailbox TEXT NOT NULL,
        uid_validity TEXT NOT NULL,
        uid INTEGER NOT NULL,
        message_id TEXT,
        sender_name TEXT,
        sender_address TEXT NOT NULL,
        subject TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        text_excerpt TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        force_notify INTEGER NOT NULL CHECK (force_notify IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'notified', 'ignored', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_attempt_at INTEGER NOT NULL,
        triage_json TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        processed_at INTEGER,
        UNIQUE(account, mailbox, uid_validity, uid)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS incoming_emails_due_idx ON incoming_emails(status, next_attempt_at, received_at);

      CREATE TABLE IF NOT EXISTS style_feedback (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN ('questions', 'verbosity', 'service_tone', 'persona', 'positive')),
        sentiment TEXT NOT NULL CHECK (sentiment IN ('negative', 'positive')),
        instruction TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        target_outbox_id TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(source_message_id, category)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS style_feedback_recent_idx ON style_feedback(created_at DESC);

      CREATE TABLE IF NOT EXISTS dialogue_audit (
        id TEXT PRIMARY KEY,
        source_message_id TEXT,
        intent TEXT NOT NULL,
        move TEXT NOT NULL,
        question_budget INTEGER NOT NULL CHECK (question_budget IN (0, 1)),
        max_chars INTEGER NOT NULL,
        rewritten INTEGER NOT NULL CHECK (rewritten IN (0, 1)),
        violations_json TEXT NOT NULL,
        final_length INTEGER NOT NULL,
        final_question_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS dialogue_audit_recent_idx ON dialogue_audit(created_at DESC);

      CREATE INDEX IF NOT EXISTS memory_jobs_due_idx ON memory_extraction_jobs(status, next_attempt_at);
    `);
    const stickerColumns = this.database.prepare("PRAGMA table_info(stickers)").all() as Array<{ name: string }>;
    if (!stickerColumns.some((column) => column.name === "native_payload_json")) {
      this.database.exec("ALTER TABLE stickers ADD COLUMN native_payload_json TEXT");
    }
    const inboundColumns = this.database.prepare("PRAGMA table_info(inbound_messages)").all() as Array<{ name: string }>;
    if (!inboundColumns.some((column) => column.name === "conversation_visible")) {
      this.database.exec("ALTER TABLE inbound_messages ADD COLUMN conversation_visible INTEGER NOT NULL DEFAULT 1 CHECK (conversation_visible IN (0, 1))");
    }
  }

  private upsertMemory(input: {
    kind: MemoryKind | "explicit";
    subject: string;
    key: string;
    content: string;
    importance: number;
    confidence: number;
    explicit: boolean;
    sourceMessageId: string | null;
    now: number;
  }): LongTermMemory {
    const subject = input.subject.trim().slice(0, 80);
    const key = input.key.trim().toLowerCase().slice(0, 80);
    const content = input.content.trim().slice(0, 500);
    if (!subject || !key || !content) throw new Error("记忆字段不能为空");
    const identity = `${input.kind}|${subject.toLowerCase()}|${key}`;
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO memories (
        id, identity_key, kind, subject, memory_key, content, importance, confidence,
        explicit, status, source_message_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT(identity_key) DO UPDATE SET
        content = excluded.content,
        importance = excluded.importance,
        confidence = excluded.confidence,
        explicit = MAX(memories.explicit, excluded.explicit),
        status = 'active',
        source_message_id = excluded.source_message_id,
        updated_at = excluded.updated_at
    `).run(
      id, identity, input.kind, subject, key, content,
      Math.max(1, Math.min(5, Math.round(input.importance))),
      Math.max(0, Math.min(1, input.confidence)),
      input.explicit ? 1 : 0,
      input.sourceMessageId,
      input.now,
      input.now,
    );
    const row = this.database.prepare(`
      SELECT id, kind, subject, memory_key, content, importance, confidence, explicit, updated_at
      FROM memories WHERE identity_key = ?
    `).get(identity) as MemoryRow;
    return asLongTermMemory(row);
  }

  private resolveActionToken(token: string): CoreAction {
    const normalized = token.trim().toLowerCase();
    if (!/^[0-9a-f-]{6,36}$/u.test(normalized)) throw new Error("行动编号格式不正确");
    const rows = this.database.prepare(`
      SELECT id, kind, status, summary, payload_json, attempts, max_attempts, next_attempt_at
      FROM actions WHERE lower(id) LIKE ? ORDER BY created_at DESC LIMIT 2
    `).all(`${normalized}%`) as ActionRow[];
    if (rows.length === 0) throw new Error("找不到这个行动");
    if (rows.length > 1) throw new Error("行动编号不够明确，请输入更多字符");
    return asCoreAction(rows[0]);
  }

  private resolveTaskToken(token: string): TaskItem {
    const normalized = token.trim().toLowerCase();
    if (!/^[0-9a-f-]{6,36}$/u.test(normalized)) throw new Error("任务编号格式不正确");
    const rows = this.database.prepare("SELECT * FROM tasks WHERE lower(id) LIKE ? ORDER BY created_at DESC LIMIT 2").all(`${normalized}%`) as TaskRow[];
    if (rows.length === 0) throw new Error("找不到这个任务");
    if (rows.length > 1) throw new Error("任务编号不够明确，请输入更多字符");
    return asTaskItem(rows[0]);
  }
}

interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: number | null;
  notification_stage: string;
  created_at: number;
  updated_at: number;
}

interface IncomingEmailRow {
  id: string;
  sender_name: string | null;
  sender_address: string;
  subject: string;
  received_at: number;
  text_excerpt: string;
  attachments_json: string;
  force_notify: number;
  attempts: number;
  max_attempts: number;
}

function asIncomingEmailJob(row: IncomingEmailRow): IncomingEmailJob {
  const parsed = JSON.parse(row.attachments_json) as unknown;
  const attachments = Array.isArray(parsed) ? parsed.filter((item): item is IncomingEmailJob["attachments"][number] => {
    if (!item || typeof item !== "object") return false;
    const value = item as Record<string, unknown>;
    return typeof value.filename === "string" && typeof value.contentType === "string"
      && (typeof value.size === "number" || value.size === null);
  }).slice(0, 30) : [];
  return {
    id: row.id,
    senderName: row.sender_name,
    senderAddress: row.sender_address,
    subject: row.subject,
    receivedAt: row.received_at,
    textExcerpt: row.text_excerpt,
    attachments,
    forceNotify: row.force_notify === 1,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

function asTaskItem(row: TaskRow): TaskItem {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    priority: row.priority,
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ActionRow {
  id: string;
  kind: string;
  status: ActionStatus;
  summary: string;
  payload_json: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: number;
}

function asCoreAction(row: ActionRow): CoreAction {
  const payload = JSON.parse(row.payload_json) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("行动载荷损坏");
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    payload: payload as Record<string, unknown>,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
  };
}

interface MemoryRow {
  id: string;
  kind: MemoryKind | "explicit";
  subject: string;
  memory_key: string;
  content: string;
  importance: number;
  confidence: number;
  explicit: number;
  updated_at: number;
}

interface MemoryJobRow {
  id: string;
  source_message_id: string;
  text: string;
  attempts: number;
  max_attempts: number;
}

function asLongTermMemory(row: MemoryRow): LongTermMemory {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    key: row.memory_key,
    content: row.content,
    importance: row.importance,
    confidence: row.confidence,
    explicit: row.explicit === 1,
    updatedAt: row.updated_at,
  };
}

function memoryTokens(value: string): string[] {
  const normalized = value.toLowerCase();
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9_@.-]{2,}/gu)) tokens.add(match[0]);
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const text = match[0];
    if (text.length <= 4) tokens.add(text);
    for (let index = 0; index < text.length - 1; index += 1) tokens.add(text.slice(index, index + 2));
  }
  return [...tokens].slice(0, 80);
}

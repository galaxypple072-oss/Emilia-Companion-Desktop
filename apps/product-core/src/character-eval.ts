import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CharacterEvalMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CharacterEvalCase {
  id: string;
  category: string;
  title: string;
  scenario?: string;
  messages: CharacterEvalMessage[];
  expectations: {
    maxChars?: number;
    maxQuestions?: number;
    maxBubbles?: number;
    forbiddenSubstrings?: string[];
    humanChecks?: string[];
  };
}

export interface CandidateMetrics {
  chars: number;
  bubbles: number;
  questions: number;
  markdownLists: number;
  serviceTone: boolean;
  stageDirection: boolean;
  protocolLeak: boolean;
  repeatedClause: boolean;
  hardFailures: string[];
}

export type HumanChoice = "left" | "right" | "tie" | "both_bad";

export interface BlindPair {
  id: string;
  runId: string;
  caseId: string;
  category: string;
  title: string;
  scenario: string | null;
  messages: CharacterEvalMessage[];
  expectations: CharacterEvalCase["expectations"];
  leftText: string;
  rightText: string;
  leftMetrics: CandidateMetrics;
  rightMetrics: CandidateMetrics;
}

function normalizedClauses(text: string): string[] {
  return text
    .split(/[。！？!?…\n]+/u)
    .map((part) => part.replace(/\s+/gu, "").trim())
    .filter((part) => part.length >= 5);
}

export function measureCandidate(text: string, evalCase: CharacterEvalCase): CandidateMetrics {
  const normalized = text.trim();
  const clauses = normalizedClauses(normalized);
  const seen = new Set<string>();
  const repeatedClause = clauses.some((clause) => seen.has(clause) || !seen.add(clause));
  const metrics: CandidateMetrics = {
    chars: [...normalized].length,
    bubbles: normalized ? normalized.split(/\n+/u).filter(Boolean).length : 0,
    questions: normalized.match(/[?？]/gu)?.length ?? 0,
    markdownLists: normalized.match(/(?:^|\n)\s*(?:[-*+]\s|\d+[.)、]\s*)/gu)?.length ?? 0,
    serviceTone: /(?:我理解你的感受|很高兴为你服务|还有什么可以帮你|以下是几点建议|综上所述)/u.test(normalized),
    stageDirection: /(?:^|\n)\s*(?:[（(][^（）()\n]{1,160}[）)]|[*＊][^*＊\n]{1,160}[*＊])/u.test(normalized),
    protocolLeak: /[{}]|["']?bubbles["']?\s*:/iu.test(normalized),
    repeatedClause,
    hardFailures: [],
  };
  const expected = evalCase.expectations;
  if (expected.maxChars !== undefined && metrics.chars > expected.maxChars) metrics.hardFailures.push(`超过 ${expected.maxChars} 字`);
  if (expected.maxQuestions !== undefined && metrics.questions > expected.maxQuestions) metrics.hardFailures.push(`问题超过 ${expected.maxQuestions} 个`);
  if (expected.maxBubbles !== undefined && metrics.bubbles > expected.maxBubbles) metrics.hardFailures.push(`气泡超过 ${expected.maxBubbles} 个`);
  if (metrics.markdownLists > 0) metrics.hardFailures.push("普通聊天使用列表");
  if (metrics.serviceTone) metrics.hardFailures.push("客服或报告腔");
  if (metrics.stageDirection) metrics.hardFailures.push("动作或舞台旁白");
  if (metrics.protocolLeak) metrics.hardFailures.push("内部协议泄漏");
  if (metrics.repeatedClause) metrics.hardFailures.push("回复内部重复");
  for (const forbidden of expected.forbiddenSubstrings ?? []) {
    if (forbidden && normalized.includes(forbidden)) metrics.hardFailures.push(`出现禁用表达：${forbidden}`);
  }
  return metrics;
}

function validateCase(value: unknown, line: number): CharacterEvalCase {
  if (!value || typeof value !== "object") throw new Error(`测试集第 ${line} 行不是对象`);
  const item = value as Partial<CharacterEvalCase>;
  if (!item.id || !item.category || !item.title || !Array.isArray(item.messages) || item.messages.length === 0) {
    throw new Error(`测试集第 ${line} 行缺少 id/category/title/messages`);
  }
  if (!item.messages.every((message) => message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string")) {
    throw new Error(`测试集第 ${line} 行包含无效消息`);
  }
  if (item.messages.at(-1)?.role !== "user") throw new Error(`测试集第 ${line} 行最后一条必须来自用户`);
  return { ...item, expectations: item.expectations ?? {} } as CharacterEvalCase;
}

export function loadCharacterEvalCases(path: string): CharacterEvalCase[] {
  const ids = new Set<string>();
  return readFileSync(path, "utf8").split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
    .map((line, index) => {
      const item = validateCase(JSON.parse(line) as unknown, index + 1);
      if (ids.has(item.id)) throw new Error(`测试 ID 重复：${item.id}`);
      ids.add(item.id);
      return item;
    });
}

interface PairRow {
  id: string;
  run_id: string;
  case_id: string;
  category: string;
  title: string;
  scenario: string | null;
  messages_json: string;
  expectations_json: string;
  left_text: string;
  right_text: string;
  left_metrics_json: string;
  right_metrics_json: string;
}

export class CharacterEvalStore {
  readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path, { timeout: 5000 });
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS eval_runs (
        id TEXT PRIMARY KEY,
        label_a TEXT NOT NULL,
        label_b TEXT NOT NULL,
        model_a TEXT NOT NULL,
        model_b TEXT NOT NULL,
        prompt_a_hash TEXT NOT NULL,
        prompt_b_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS eval_pairs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES eval_runs(id),
        case_id TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        scenario TEXT,
        messages_json TEXT NOT NULL,
        expectations_json TEXT NOT NULL,
        left_text TEXT NOT NULL,
        right_text TEXT NOT NULL,
        left_raw_text TEXT,
        right_raw_text TEXT,
        left_meta_json TEXT,
        right_meta_json TEXT,
        left_variant TEXT NOT NULL CHECK(left_variant IN ('a','b')),
        right_variant TEXT NOT NULL CHECK(right_variant IN ('a','b')),
        left_metrics_json TEXT NOT NULL,
        right_metrics_json TEXT NOT NULL,
        repetition INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(run_id, case_id, repetition)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS eval_reviews (
        id TEXT PRIMARY KEY,
        pair_id TEXT NOT NULL UNIQUE REFERENCES eval_pairs(id),
        choice TEXT NOT NULL CHECK(choice IN ('left','right','tie','both_bad')),
        reason_tags_json TEXT NOT NULL,
        note TEXT NOT NULL,
        confidence INTEGER NOT NULL CHECK(confidence BETWEEN 1 AND 5),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS eval_pairs_run_idx ON eval_pairs(run_id, created_at);
    `);
    const pairColumns = this.database.prepare("PRAGMA table_info(eval_pairs)").all() as Array<{ name: string }>;
    if (!pairColumns.some((column) => column.name === "left_raw_text")) this.database.exec("ALTER TABLE eval_pairs ADD COLUMN left_raw_text TEXT");
    if (!pairColumns.some((column) => column.name === "right_raw_text")) this.database.exec("ALTER TABLE eval_pairs ADD COLUMN right_raw_text TEXT");
    if (!pairColumns.some((column) => column.name === "left_meta_json")) this.database.exec("ALTER TABLE eval_pairs ADD COLUMN left_meta_json TEXT");
    if (!pairColumns.some((column) => column.name === "right_meta_json")) this.database.exec("ALTER TABLE eval_pairs ADD COLUMN right_meta_json TEXT");
  }

  close(): void { this.database.close(); }

  createRun(input: { labelA: string; labelB: string; modelA: string; modelB: string; promptAHash: string; promptBHash: string }, now = Date.now()): string {
    const id = randomUUID();
    this.database.prepare(`INSERT INTO eval_runs(id,label_a,label_b,model_a,model_b,prompt_a_hash,prompt_b_hash,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, input.labelA, input.labelB, input.modelA, input.modelB, input.promptAHash, input.promptBHash, now);
    return id;
  }

  addPair(input: {
    runId: string;
    evalCase: CharacterEvalCase;
    textA: string;
    textB: string;
    rawTextA?: string;
    rawTextB?: string;
    metaA?: Record<string, unknown>;
    metaB?: Record<string, unknown>;
    repetition: number;
    swap?: boolean;
  }, now = Date.now()): string {
    const swap = input.swap ?? randomInt(2) === 1;
    const leftText = swap ? input.textB : input.textA;
    const rightText = swap ? input.textA : input.textB;
    const leftRawText = swap ? (input.rawTextB ?? input.textB) : (input.rawTextA ?? input.textA);
    const rightRawText = swap ? (input.rawTextA ?? input.textA) : (input.rawTextB ?? input.textB);
    const leftMeta = swap ? (input.metaB ?? {}) : (input.metaA ?? {});
    const rightMeta = swap ? (input.metaA ?? {}) : (input.metaB ?? {});
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO eval_pairs(
        id,run_id,case_id,category,title,scenario,messages_json,expectations_json,
        left_text,right_text,left_raw_text,right_raw_text,left_meta_json,right_meta_json,left_variant,right_variant,left_metrics_json,right_metrics_json,repetition,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, input.runId, input.evalCase.id, input.evalCase.category, input.evalCase.title, input.evalCase.scenario ?? null,
      JSON.stringify(input.evalCase.messages), JSON.stringify(input.evalCase.expectations), leftText, rightText, leftRawText, rightRawText, JSON.stringify(leftMeta), JSON.stringify(rightMeta),
      swap ? "b" : "a", swap ? "a" : "b", JSON.stringify(measureCandidate(leftText, input.evalCase)),
      JSON.stringify(measureCandidate(rightText, input.evalCase)), input.repetition, now,
    );
    return id;
  }

  nextBlindPair(runId?: string): BlindPair | null {
    const row = this.database.prepare(`
      SELECT p.id,p.run_id,p.case_id,p.category,p.title,p.scenario,p.messages_json,p.expectations_json,
             p.left_text,p.right_text,p.left_metrics_json,p.right_metrics_json
      FROM eval_pairs p LEFT JOIN eval_reviews r ON r.pair_id=p.id
      WHERE r.id IS NULL AND (? IS NULL OR p.run_id=?)
      ORDER BY p.created_at,p.rowid LIMIT 1
    `).get(runId ?? null, runId ?? null) as PairRow | undefined;
    if (!row) return null;
    return {
      id: row.id, runId: row.run_id, caseId: row.case_id, category: row.category, title: row.title,
      scenario: row.scenario, messages: JSON.parse(row.messages_json) as CharacterEvalMessage[],
      expectations: JSON.parse(row.expectations_json) as CharacterEvalCase["expectations"],
      leftText: row.left_text, rightText: row.right_text,
      leftMetrics: JSON.parse(row.left_metrics_json) as CandidateMetrics,
      rightMetrics: JSON.parse(row.right_metrics_json) as CandidateMetrics,
    };
  }

  recordReview(input: { pairId: string; choice: HumanChoice; reasonTags?: string[]; note?: string; confidence?: number }, now = Date.now()): void {
    if (!["left", "right", "tie", "both_bad"].includes(input.choice)) throw new Error("无效选择");
    const confidence = Math.max(1, Math.min(5, Math.trunc(input.confidence ?? 3)));
    this.database.prepare(`INSERT INTO eval_reviews(id,pair_id,choice,reason_tags_json,note,confidence,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(randomUUID(), input.pairId, input.choice, JSON.stringify((input.reasonTags ?? []).slice(0, 12)), (input.note ?? "").trim().slice(0, 1000), confidence, now);
  }

  report(runId?: string): Record<string, unknown> {
    const run = runId
      ? this.database.prepare("SELECT * FROM eval_runs WHERE id=?").get(runId)
      : this.database.prepare("SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT 1").get();
    if (!run) return { runs: 0, message: "还没有实验" };
    const meta = run as { id: string; label_a: string; label_b: string; model_a: string; model_b: string; created_at: number };
    const rows = this.database.prepare(`
      SELECT p.category,p.left_variant,p.right_variant,p.left_metrics_json,p.right_metrics_json,r.choice,r.reason_tags_json,r.confidence
      FROM eval_pairs p LEFT JOIN eval_reviews r ON r.pair_id=p.id WHERE p.run_id=?
    `).all(meta.id) as Array<{ category: string; left_variant: "a"|"b"; right_variant: "a"|"b"; left_metrics_json: string; right_metrics_json: string; choice: HumanChoice|null; reason_tags_json: string|null; confidence: number|null }>;
    let winsA = 0; let winsB = 0; let ties = 0; let bothBad = 0; let reviewed = 0; let hardA = 0; let hardB = 0;
    const categories: Record<string, { reviewed: number; winsA: number; winsB: number; ties: number; bothBad: number }> = {};
    const reasons: Record<string, number> = {};
    for (const row of rows) {
      const leftMetrics = JSON.parse(row.left_metrics_json) as CandidateMetrics;
      const rightMetrics = JSON.parse(row.right_metrics_json) as CandidateMetrics;
      hardA += (row.left_variant === "a" ? leftMetrics : rightMetrics).hardFailures.length > 0 ? 1 : 0;
      hardB += (row.left_variant === "b" ? leftMetrics : rightMetrics).hardFailures.length > 0 ? 1 : 0;
      if (!row.choice) continue;
      reviewed += 1;
      const bucket = categories[row.category] ??= { reviewed: 0, winsA: 0, winsB: 0, ties: 0, bothBad: 0 };
      bucket.reviewed += 1;
      if (row.choice === "tie") { ties += 1; bucket.ties += 1; }
      else if (row.choice === "both_bad") { bothBad += 1; bucket.bothBad += 1; }
      else {
        const winner = row.choice === "left" ? row.left_variant : row.right_variant;
        if (winner === "a") { winsA += 1; bucket.winsA += 1; } else { winsB += 1; bucket.winsB += 1; }
      }
      for (const tag of JSON.parse(row.reason_tags_json ?? "[]") as string[]) reasons[tag] = (reasons[tag] ?? 0) + 1;
    }
    const decisive = winsA + winsB;
    const winRateB = decisive ? winsB / decisive : null;
    const recommendation = reviewed < 30
      ? { status: "insufficient_data", reason: `至少完成 30 组盲选；当前 ${reviewed} 组` }
      : hardB > hardA
        ? { status: "hold", reason: "候选版的机械硬错误多于当前版，先修复再比较" }
        : winRateB !== null && winRateB >= 0.6
          ? { status: "promote_b", reason: "候选版通过硬指标安全门，且获得至少 60% 的明确人工偏好" }
          : winRateB !== null && winRateB <= 0.4
            ? { status: "keep_a", reason: "当前版获得至少 60% 的明确人工偏好" }
            : { status: "inconclusive", reason: "人工偏好差异还不足以支持切换" };
    return {
      runId: meta.id,
      createdAt: new Date(meta.created_at).toISOString(),
      variants: { a: { label: meta.label_a, model: meta.model_a }, b: { label: meta.label_b, model: meta.model_b } },
      progress: { total: rows.length, reviewed, remaining: rows.length - reviewed },
      ownerPreference: { winsA, winsB, ties, bothBad, winRateA: decisive ? winsA / decisive : null, winRateB },
      automaticHardFailures: { a: hardA, b: hardB },
      categories,
      reasonTags: reasons,
      recommendation,
      decisionRule: "人工盲选是主结论；硬指标只作为安全门，不与人工偏好混成一个总分。",
    };
  }

  preferenceRecords(runId?: string): Array<Record<string, unknown>> {
    const selectedRunId = runId ?? (this.database.prepare("SELECT id FROM eval_runs ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined)?.id;
    if (!selectedRunId) return [];
    const rows = this.database.prepare(`
      SELECT p.case_id,p.category,p.title,p.scenario,p.messages_json,p.expectations_json,
             p.left_text,p.right_text,p.left_raw_text,p.right_raw_text,p.left_meta_json,p.right_meta_json,p.left_variant,p.right_variant,p.left_metrics_json,p.right_metrics_json,
             r.choice,r.reason_tags_json,r.note,r.confidence,r.created_at
      FROM eval_pairs p JOIN eval_reviews r ON r.pair_id=p.id
      WHERE p.run_id=? ORDER BY r.created_at,r.rowid
    `).all(selectedRunId) as Array<Record<string, string | number | null>>;
    return rows.map((row) => {
      const choice = row.choice as HumanChoice;
      const preferredSide = choice === "left" || choice === "right" ? choice : null;
      const rejectedSide = preferredSide === "left" ? "right" : preferredSide === "right" ? "left" : null;
      return {
        schemaVersion: 1,
        runId: selectedRunId,
        caseId: row.case_id,
        category: row.category,
        title: row.title,
        scenario: row.scenario,
        messages: JSON.parse(String(row.messages_json)),
        expectations: JSON.parse(String(row.expectations_json)),
        human: {
          choice,
          confidence: row.confidence,
          reasonTags: JSON.parse(String(row.reason_tags_json)),
          note: row.note,
          reviewedAt: new Date(Number(row.created_at)).toISOString(),
        },
        preferred: preferredSide ? {
          text: row[`${preferredSide}_text`],
          rawText: row[`${preferredSide}_raw_text`] ?? row[`${preferredSide}_text`],
          meta: JSON.parse(String(row[`${preferredSide}_meta_json`] ?? "{}")),
          variant: row[`${preferredSide}_variant`],
          metrics: JSON.parse(String(row[`${preferredSide}_metrics_json`])),
        } : null,
        rejected: rejectedSide ? {
          text: row[`${rejectedSide}_text`],
          rawText: row[`${rejectedSide}_raw_text`] ?? row[`${rejectedSide}_text`],
          meta: JSON.parse(String(row[`${rejectedSide}_meta_json`] ?? "{}")),
          variant: row[`${rejectedSide}_variant`],
          metrics: JSON.parse(String(row[`${rejectedSide}_metrics_json`])),
        } : null,
        candidates: choice === "tie" || choice === "both_bad" ? {
          left: { text: row.left_text, rawText: row.left_raw_text ?? row.left_text, meta: JSON.parse(String(row.left_meta_json ?? "{}")), variant: row.left_variant, metrics: JSON.parse(String(row.left_metrics_json)) },
          right: { text: row.right_text, rawText: row.right_raw_text ?? row.right_text, meta: JSON.parse(String(row.right_meta_json ?? "{}")), variant: row.right_variant, metrics: JSON.parse(String(row.right_metrics_json)) },
        } : undefined,
      };
    });
  }
}

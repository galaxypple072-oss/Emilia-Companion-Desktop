import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapter, AgentRequest } from "../src/agent.ts";
import { EmailTriageService, formatImportantEmail, parseEmailTriage } from "../src/email-inbox-triage.ts";
import { loadImapInboxConfig } from "../src/imap-inbox.ts";
import { ProductStore, type IncomingEmailJob } from "../src/store.ts";

const emailConfig = {
  host: "smtp.163.com",
  port: 465,
  secure: true,
  user: "owner@example.com",
  password: "authorization-code",
  from: "owner@example.com",
  bossEmail: "boss@example.com",
};

function candidate(uid = 1) {
  return {
    account: "owner@example.com",
    mailbox: "INBOX",
    uidValidity: "42",
    uid,
    messageId: `<${uid}@example.com>`,
    senderName: "Boss",
    senderAddress: "boss@example.com",
    subject: "项目截止时间调整",
    receivedAt: 1000,
    textExcerpt: "请在周五前处理。",
    attachments: [{ filename: "schedule.pdf", contentType: "application/pdf", size: 123 }],
    forceNotify: true,
    now: 1000,
  };
}

test("loads bounded read-only inbox settings and reuses email credentials", () => {
  const config = loadImapInboxConfig({
    EMAIL_INBOX_ENABLED: "true",
    EMAIL_IMPORTANT_SENDERS: "friend@example.com; ALERT@example.com",
  }, emailConfig)!;
  assert.equal(config.host, "imap.163.com");
  assert.equal(config.port, 993);
  assert.equal(config.user, emailConfig.user);
  assert.equal(config.password, emailConfig.password);
  assert.equal(config.pollIntervalMs, 120_000);
  assert.equal(config.importantSenders.has("boss@example.com"), true);
  assert.equal(config.importantSenders.has("alert@example.com"), true);
  assert.throws(() => loadImapInboxConfig({ EMAIL_INBOX_ENABLED: "true", EMAIL_INBOX_POLL_SECONDS: "5" }, emailConfig));
});

test("parses strict triage output and rejects incomplete notifications", () => {
  assert.deepEqual(parseEmailTriage('{"notify":false,"urgency":"normal","summary":"","reason":""}'), {
    notify: false, urgency: "normal", summary: "", reason: "",
  });
  assert.throws(() => parseEmailTriage('{"notify":true,"urgency":"urgent","summary":"","reason":""}'));
});

test("triage treats message content as untrusted data", async () => {
  let request: AgentRequest | null = null;
  const agent: AgentAdapter = {
    async generateReply(value) {
      request = value;
      return '{"notify":true,"urgency":"important","summary":"周五前处理项目变更","reason":"有明确截止时间"}';
    },
  };
  const job: IncomingEmailJob = { ...candidate(), id: "job-1", attempts: 1, maxAttempts: 3 };
  const result = await new EmailTriageService(agent).triage(job);
  assert.equal(result.notify, true);
  assert.match(request!.systemPrompt, /不可信数据/u);
  assert.match(request!.messages[0].content, /<UNTRUSTED_EMAIL>/u);
});

test("durably deduplicates, classifies, and queues incoming email notifications", () => {
  const store = new ProductStore(":memory:");
  try {
    assert.equal(store.ingestIncomingEmail(candidate()), true);
    assert.equal(store.ingestIncomingEmail(candidate()), false);
    const job = store.claimIncomingEmail(1000)!;
    assert.equal(job.attempts, 1);
    const triage = { notify: true, urgency: "important" as const, summary: "周五前处理项目变更", reason: "有明确截止时间" };
    store.completeIncomingEmail(job, {
      notify: true,
      triage,
      notificationBody: formatImportantEmail(job, triage),
      recipientId: "123456789",
    }, 1100);
    assert.deepEqual(store.summary(1100).incoming_emails, { notified: 1 });
    assert.match(store.claimDue(1100)!.body, /schedule\.pdf/u);
  } finally {
    store.close();
  }
});

test("retries interrupted inbox work without losing the message", () => {
  const store = new ProductStore(":memory:");
  try {
    store.ingestIncomingEmail(candidate(2));
    const first = store.claimIncomingEmail(1000)!;
    assert.equal(store.failIncomingEmail(first, "temporary", 1000), "pending");
    assert.equal(store.claimIncomingEmail(15_999), null);
    assert.ok(store.claimIncomingEmail(16_000));
    assert.equal(store.recoverIncomingEmails(17_000), 1);
    assert.ok(store.claimIncomingEmail(17_000));
  } finally {
    store.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { parseDelay } from "../src/config.ts";
import { ProductStore } from "../src/store.ts";

test("queues, claims, retries, and completes durable outbound messages", () => {
  const store = new ProductStore(":memory:");
  try {
    const id = store.enqueue({ recipientId: "123456789", body: "hello", dueAt: 1000 });
    const claimed = store.claimDue(1000);
    assert.equal(claimed?.id, id);
    assert.equal(claimed?.attempts, 1);
    assert.equal(store.markFailed(claimed!, "temporary", 1000), "pending");
    assert.equal(store.claimDue(5999), null);
    const retried = store.claimDue(6000);
    assert.equal(retried?.attempts, 2);
    store.markSent(id, "message-1", 7000);
    assert.deepEqual(store.summary(7000).outbox, { sent: 1 });
  } finally {
    store.close();
  }
});

test("deduplicates inbound events", () => {
  const store = new ProductStore(":memory:");
  try {
    const event = {
      channel: "qq_onebot",
      externalMessageId: "42",
      senderId: "123456789",
      body: "ping",
      receivedAt: 1000,
    };
    assert.equal(store.recordInbound(event), true);
    assert.equal(store.recordInbound(event), false);
    assert.equal(store.summary().inbound, 1);
  } finally {
    store.close();
  }
});

test("conversation history also combines desktop bridge messages", () => {
  const store = new ProductStore(":memory:");
  try {
    store.recordCompanionMessage({ ownerId: "123", clientId: "mac", externalMessageId: "desktop-1", role: "user", content: "Mac 上说的话", occurredAt: 1000 });
    store.recordCompanionMessage({ ownerId: "123", clientId: "mac", externalMessageId: "desktop-1-reply", role: "assistant", content: "Mac 上的回复", occurredAt: 1001 });
    assert.deepEqual(store.recentConversation("123", 10), [
      { role: "user", content: "Mac 上说的话" },
      { role: "assistant", content: "Mac 上的回复" },
    ]);
    assert.equal(store.latestAssistantConversationAt("123"), 1001);
    assert.equal(store.latestAssistantConversationAt("123", 1002), null);
  } finally {
    store.close();
  }
});

test("keeps silent nonverbal events out of model conversation history", () => {
  const store = new ProductStore(":memory:");
  try {
    store.recordInbound({
      channel: "qq_onebot", externalMessageId: "sticker-1", senderId: "123",
      body: "[QQ表情]", receivedAt: 1000, conversationVisible: false,
    });
    store.recordInbound({
      channel: "qq_onebot", externalMessageId: "text-1", senderId: "123",
      body: "我接着说", receivedAt: 2000,
    });
    assert.deepEqual(store.recentConversation("123", 10), [{ role: "user", content: "我接着说" }]);
    assert.equal(store.latestInboundExternalMessageId("123"), "text-1");
  } finally {
    store.close();
  }
});

test("orders a completed image analysis after replies sent while vision was running", () => {
  const store = new ProductStore(":memory:");
  try {
    store.recordInbound({
      channel: "qq_onebot",
      externalMessageId: "image-1",
      senderId: "123456789",
      body: "[图片]",
      receivedAt: 1000,
    });
    const replyId = store.enqueue({ recipientId: "123456789", body: "上一句话的回复", dueAt: 1500 });
    assert.ok(store.claimDue(1500));
    store.markSent(replyId, "reply-1", 2000);

    store.recordImageAnalysis("qq_onebot", "image-1", "图片里是一只不开心的猫");

    assert.deepEqual(store.recentConversation("123456789", 10), [
      { role: "assistant", content: "上一句话的回复" },
      { role: "user", content: "图片里是一只不开心的猫" },
    ]);
  } finally {
    store.close();
  }
});

test("recovers messages interrupted while sending", () => {
  const store = new ProductStore(":memory:");
  try {
    store.enqueue({ recipientId: "123456789", body: "recover", dueAt: 1000 });
    assert.ok(store.claimDue(1000));
    assert.equal(store.recoverInterrupted(2000), 1);
    assert.ok(store.claimDue(2000));
  } finally {
    store.close();
  }
});

test("persists, confirms, retries, completes, and cancels actions", () => {
  const store = new ProductStore(":memory:");
  try {
    const first = store.createAction({
      kind: "send_email",
      summary: "发送测试邮件",
      payload: { subject: "测试", body: "正文" },
      dedupeKey: "email:1",
    });
    assert.equal(first.created, true);
    assert.equal(store.createAction({
      kind: "send_email",
      summary: "重复",
      payload: { subject: "重复", body: "重复" },
      dedupeKey: "email:1",
    }).id, first.id);
    assert.equal(store.claimDueAction(1000), null);
    store.confirmAction(first.id.slice(0, 8), 1000);
    const running = store.claimDueAction(1000)!;
    assert.equal(running.status, "running");
    assert.equal(store.markActionFailed(running, "temporary", 1000), "approved");
    const retry = store.claimDueAction(6000)!;
    store.markActionCompleted(retry.id, "smtp-id", 7000);
    assert.equal(store.listActions()[0].status, "completed");

    const second = store.createAction({ kind: "send_email", summary: "取消", payload: {} });
    store.cancelAction(second.id.slice(0, 8), 8000);
    assert.equal(store.listActions()[0].status, "cancelled");
  } finally {
    store.close();
  }
});

test("stores contacts and resolves aliases or explicit addresses", () => {
  const store = new ProductStore(":memory:");
  try {
    store.upsertContact("老板", "boss@example.com", 1000);
    assert.deepEqual(store.resolveEmailRecipient("老板"), { label: "老板", email: "boss@example.com" });
    assert.deepEqual(store.resolveEmailRecipient("Other@Example.com"), { label: "Other@Example.com", email: "other@example.com" });
    assert.equal(store.listContacts().length, 1);
    assert.equal(store.removeContact("老板"), true);
    assert.throws(() => store.resolveEmailRecipient("老板"), /找不到联系人/u);
  } finally {
    store.close();
  }
});

test("parses bounded human-friendly reminder delays", () => {
  assert.equal(parseDelay("30s"), 30_000);
  assert.equal(parseDelay("10m"), 600_000);
  assert.equal(parseDelay("2h"), 7_200_000);
  assert.throws(() => parseDelay("tomorrow"));
});

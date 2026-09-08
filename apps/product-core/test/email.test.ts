import assert from "node:assert/strict";
import test from "node:test";
import { handleEmailInstruction } from "../src/email-command.ts";
import { parseEmailInstruction } from "../src/email.ts";
import { ProductStore } from "../src/store.ts";

test("parses deterministic slash command", () => {
  assert.deepEqual(parseEmailInstruction("/email 周报 | 本周功能已经完成。"), {
    recipient: "老板",
    subject: "周报",
    body: "本周功能已经完成。",
  });
});

test("parses a constrained Chinese natural-language instruction", () => {
  assert.deepEqual(parseEmailInstruction("给张三发邮件，主题：项目进度，内容：今天已经完成联调。"), {
    recipient: "张三",
    subject: "项目进度",
    body: "今天已经完成联调。",
  });
});

test("parses conversational Chinese email wording", () => {
  assert.deepEqual(parseEmailInstruction("帮我给同事发封邮件，主题是会议安排，内容是明天下午三点开会。"), {
    recipient: "同事",
    subject: "会议安排",
    body: "明天下午三点开会。",
  });
});

test("creates a durable draft that requires confirmation", () => {
  const store = new ProductStore(":memory:");
  try {
    const result = handleEmailInstruction("/email test@example.com | 测试 | 你好", store, "qq-email:1", true);
    assert.equal(result.handled, true);
    assert.match(result.reply ?? "", /尚未发送/u);
    assert.equal(store.listActions()[0].status, "pending_confirmation");
    assert.match(store.listActions()[0].summary, /test@example.com/u);
    assert.equal(store.claimDueAction(), null);
  } finally {
    store.close();
  }
});

test("resolves a saved contact alias", () => {
  const store = new ProductStore(":memory:");
  try {
    store.upsertContact("张三", "zhangsan@example.com");
    const result = handleEmailInstruction("给张三发邮件，主题：你好，内容：测试正文", store, "qq-email:2", true);
    assert.match(result.reply ?? "", /zhangsan@example.com/u);
  } finally {
    store.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConfig } from "../src/agent.ts";
import { DeepSeekMemoryExtractor, memoryContext } from "../src/memory.ts";
import { ProductStore } from "../src/store.ts";

const config: AgentConfig = {
  mode: "direct",
  baseUrl: "https://example.test",
  apiKey: "secret",
  model: "deepseek-v4-flash",
  maxTokens: 800,
  temperature: 0.8,
  timeoutMs: 10_000,
  contextMessages: 20,
};

test("extracts validated durable memories from a model response", async () => {
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify([
      { kind: "preference", subject: "用户", key: "food_dislike", content: "用户不吃香菜", importance: 4, confidence: 0.98 },
      { kind: "unknown", subject: "用户", key: "bad", content: "无效", importance: 5, confidence: 1 },
    ]) } }],
  }));
  const memories = await new DeepSeekMemoryExtractor(config, config.model, fakeFetch).extract("我不吃香菜");
  assert.deepEqual(memories, [{
    kind: "preference",
    subject: "用户",
    key: "food_dislike",
    content: "用户不吃香菜",
    importance: 4,
    confidence: 0.98,
  }]);
});

test("does not send obvious credentials to automatic memory extraction", async () => {
  const extractor = new DeepSeekMemoryExtractor(config, config.model, async () => {
    throw new Error("fetch must not be called");
  });
  assert.deepEqual(await extractor.extract("我的验证码是 123456"), []);
});

test("stores, updates, retrieves, forgets, and processes memory jobs", () => {
  const store = new ProductStore(":memory:");
  try {
    const explicit = store.rememberExplicit("我不吃香菜", "m1", 1000);
    assert.equal(store.listMemories().length, 1);
    assert.equal(store.retrieveMemories("晚饭吃什么", 8, 1100)[0].id, explicit.id);

    const first = store.upsertExtractedMemory({
      kind: "project", subject: "数字伙伴", key: "stage", content: "正在实现长期记忆", importance: 4, confidence: 0.9,
    }, "m2", 1200);
    const updated = store.upsertExtractedMemory({
      kind: "project", subject: "数字伙伴", key: "stage", content: "长期记忆已经上线", importance: 5, confidence: 0.95,
    }, "m3", 1300);
    assert.equal(updated.id, first.id);
    assert.equal(updated.content, "长期记忆已经上线");

    store.upsertExtractedMemory({
      kind: "project", subject: "游戏服务器", key: "minecraft", content: "用户计划搭建游戏服务器", importance: 5, confidence: 0.95,
    }, "m-irrelevant", 1350);
    assert.deepEqual(store.retrieveMemories("我刚起床", 8, 1360).map((memory) => memory.content), ["我不吃香菜"]);

    assert.equal(store.enqueueMemoryExtraction("m4", "老板偏好简洁邮件", 1400), true);
    assert.equal(store.enqueueMemoryExtraction("m4", "重复", 1400), false);
    const job = store.claimMemoryExtraction(1400)!;
    store.completeMemoryExtraction(job, [{
      kind: "preference", subject: "老板", key: "email_style", content: "老板偏好简洁邮件", importance: 4, confidence: 0.9,
    }], 1500);
    assert.match(memoryContext(store.retrieveMemories("给老板写邮件", 8)), /老板偏好简洁邮件/u);

    store.forgetMemory(explicit.id.slice(0, 8), 1600);
    assert.equal(store.listMemories().some((memory) => memory.id === explicit.id), false);
  } finally {
    store.close();
  }
});

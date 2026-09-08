import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleAgent, type AgentConfig } from "../src/agent.ts";
import { handleCoreCommand } from "../src/commands.ts";
import { ProductStore } from "../src/store.ts";

const agentConfig: AgentConfig = {
  mode: "direct",
  baseUrl: "https://example.test",
  apiKey: "top-secret-agent-key",
  model: "test-model",
  maxTokens: 800,
  temperature: 0.8,
  timeoutMs: 10_000,
  contextMessages: 20,
  thinking: "disabled",
};

test("calls an OpenAI-compatible chat endpoint without exposing credentials", async () => {
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  const fakeFetch: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer top-secret-agent-key");
    return new Response(JSON.stringify({ choices: [{ message: { content: " 你好呀。 " } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const agent = new OpenAICompatibleAgent(agentConfig, fakeFetch);
  const reply = await agent.generateReply({
    systemPrompt: "persona",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(requestUrl, "https://example.test/chat/completions");
  assert.equal(requestBody.model, "test-model");
  assert.deepEqual(requestBody.thinking, { type: "disabled" });
  assert.equal(reply, "你好呀。");
});

test("handles local status, quiet mode, and reminder commands without an agent", () => {
  const store = new ProductStore(":memory:");
  try {
    assert.match(handleCoreCommand("/status", store, "123456789", 1000).reply!, /Product Core 正常/u);
    assert.match(handleCoreCommand("/quiet on", store, "123456789", 1000).reply!, /已开启/u);
    assert.equal(store.getState("quiet_mode"), "on");
    assert.match(handleCoreCommand("/remind 10m 喝水", store, "123456789", 1000).reply!, /提醒已记录/u);
    assert.equal((store.summary(1000).outbox as Record<string, number>).pending, 1);
    assert.match(handleCoreCommand("/interest add DeepSeek 和 AI Agent", store, "123456789", 1000).reply!, /已订阅/u);
    assert.equal(store.listInterests()[0].topic, "DeepSeek 和 AI Agent");
    assert.match(handleCoreCommand("/discover on", store, "123456789", 1100).reply!, /已开启/u);
    assert.equal(store.getState("discovery_mode"), "on");
    assert.match(handleCoreCommand("/discover now", store, "123456789", 1200).reply!, /实际搜索/u);
    assert.equal(store.getState("discovery_force_requested_at"), "1200");
    assert.equal(handleCoreCommand("普通聊天", store, "123456789").handled, false);
    const remembered = handleCoreCommand("/remember 我喜欢简洁回复", store, "123456789", 1000);
    assert.match(remembered.reply!, /记住了/u);
    assert.match(handleCoreCommand("/memory", store, "123456789", 1000).reply!, /简洁回复/u);
  } finally {
    store.close();
  }
});

test("builds ordered context from persisted inbound and delivered outbound messages", () => {
  const store = new ProductStore(":memory:");
  try {
    store.recordInbound({
      channel: "qq_onebot",
      externalMessageId: "in-1",
      senderId: "123456789",
      body: "第一句",
      receivedAt: 1000,
    });
    const id = store.enqueue({ recipientId: "123456789", body: "第二句", dueAt: 1100 });
    const claimed = store.claimDue(1100)!;
    store.markSent(id, "out-1", 1200);
    store.recordInbound({
      channel: "qq_onebot",
      externalMessageId: "in-2",
      senderId: "123456789",
      body: "第三句",
      receivedAt: 1300,
    });
    assert.deepEqual(store.recentConversation("123456789", 10), [
      { role: "user", content: "第一句" },
      { role: "assistant", content: "第二句" },
      { role: "user", content: "第三句" },
    ]);
    assert.equal(claimed.id, id);
  } finally {
    store.close();
  }
});

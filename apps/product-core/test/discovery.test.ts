import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapter } from "../src/agent.ts";
import { DiscoveryEngine, parseDiscoveryResult, type DiscoveryConfig } from "../src/discovery.ts";
import { ProductStore } from "../src/store.ts";

const config: DiscoveryConfig = {
  enabled: true,
  pollIntervalMs: 300_000,
  minimumCheckIntervalMs: 12 * 3_600_000,
  dailyShareLimit: 1,
  timeZone: "Asia/Shanghai",
};

test("validates sourced discovery JSON", () => {
  assert.deepEqual(parseDiscoveryResult('{"share":false}'), { share: false });
  const parsed = parseDiscoveryResult('{"share":true,"title":"新发布","summary":"正式发布了新版本。","url":"https://example.com/release","reason":"与你订阅的主题直接相关"}');
  assert.equal(parsed.url, "https://example.com/release");
  assert.throws(() => parseDiscoveryResult('{"share":true,"title":"x","summary":"y","url":"javascript:alert(1)","reason":"z"}'), /HTTP/u);
});

test("forced discovery searches one interest, queues a sourced item, and deduplicates the URL", async () => {
  const store = new ProductStore(":memory:");
  let calls = 0;
  const agent: AgentAdapter = {
    async generateReply() {
      calls += 1;
      return '{"share":true,"title":"DeepSeek 发布新功能","summary":"官方公布了一项新能力。","url":"https://example.com/deepseek-update","reason":"属于 AI Agent 新进展"}';
    },
  };
  try {
    store.addInterest("DeepSeek 和 AI Agent", 1000);
    store.setState("discovery_force_requested_at", "2000", 2000);
    const engine = new DiscoveryEngine(store, "123456789", agent, config);
    assert.equal(await engine.tick(3000), true);
    assert.equal(await engine.tick(4000), false);
    store.setState("discovery_force_requested_at", "5000", 5000);
    assert.equal(await engine.tick(6000), false);
    assert.equal(calls, 2);
    const message = store.claimDue(Date.now() + 1000)!;
    assert.match(message.body, /https:\/\/example\.com\/deepseek-update/u);
    assert.match(message.body, /为什么|因为/u);
  } finally {
    store.close();
  }
});

test("interest subscriptions rotate by least recently checked", () => {
  const store = new ProductStore(":memory:");
  try {
    const first = store.addInterest("人工智能", 1000);
    const second = store.addInterest("二次元游戏", 2000);
    assert.equal(store.nextInterestForCheck()!.id, first.id);
    store.markInterestChecked(first.id, 3000);
    assert.equal(store.nextInterestForCheck()!.id, second.id);
    assert.equal(store.removeInterest(second.id.slice(0, 8), 4000).topic, "二次元游戏");
  } finally {
    store.close();
  }
});

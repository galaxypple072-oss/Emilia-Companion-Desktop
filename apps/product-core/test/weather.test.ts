import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapter } from "../src/agent.ts";
import { handleCoreCommand } from "../src/commands.ts";
import { normalizeWeatherLocation, parseWeatherFinding, WeatherEngine, type WeatherConfig } from "../src/weather.ts";
import { ProductStore } from "../src/store.ts";

const config: WeatherConfig = {
  enabled: true,
  pollIntervalMs: 600_000,
  minimumCheckIntervalMs: 3 * 3_600_000,
  dailyAlertLimit: 2,
  timeZone: "Asia/Shanghai",
};

test("captures a home city from normal conversation", () => {
  const store = new ProductStore(":memory:");
  try {
    const result = handleCoreCommand("我目前常驻城市是上海", store, "123456789", 1000);
    assert.equal(result.handled, true);
    assert.match(result.reply!, /上海/u);
    assert.equal(store.getState("weather_location"), "上海");
    assert.equal(store.getState("weather_force_requested_at"), "1000");
    assert.match(handleCoreCommand("以后天气按杭州看", store, "123456789", 2000).reply!, /杭州/u);
    assert.equal(store.getState("weather_location"), "杭州");
  } finally {
    store.close();
  }
});

test("validates locations and sourced weather findings", () => {
  assert.equal(normalizeWeatherLocation(" 上海浦东新区。 "), "上海浦东新区");
  assert.throws(() => normalizeWeatherLocation("https://example.com"), /不支持/u);
  assert.deepEqual(parseWeatherFinding('{"share":false}'), { share: false });
  assert.equal(parseWeatherFinding('{"share":true,"headline":"暴雨预警","detail":"今晚有强降雨。","advice":"减少外出。","url":"https://weather.example/alert"}').headline, "暴雨预警");
});

test("forced weather check shares only a deduplicated sourced alert", async () => {
  const store = new ProductStore(":memory:");
  let calls = 0;
  const agent: AgentAdapter = {
    async generateReply() {
      calls += 1;
      return '{"share":true,"headline":"暴雨橙色预警","detail":"今晚20时至明晨有强降雨。","advice":"减少外出并避开低洼路段。","url":"https://weather.example/alerts/1"}';
    },
  };
  try {
    store.setState("weather_location", "上海", 1000);
    store.setState("weather_force_requested_at", "2000", 2000);
    const engine = new WeatherEngine(store, "123456789", agent, config);
    assert.equal(await engine.tick(3000), true);
    store.setState("weather_force_requested_at", "4000", 4000);
    assert.equal(await engine.tick(5000), false);
    assert.equal(calls, 2);
    const message = store.claimDue(Date.now() + 1000)!;
    assert.match(message.body, /上海天气提醒/u);
    assert.match(message.body, /https:\/\/weather\.example\/alerts\/1/u);
  } finally {
    store.close();
  }
});

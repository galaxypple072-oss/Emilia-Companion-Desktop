import assert from "node:assert/strict";
import test from "node:test";
import { companionTimeContext, conversationGapText } from "../src/time-context.ts";

test("renders a stable Hong Kong local time and conversation gap", () => {
  const now = Date.parse("2026-08-31T16:30:00.000Z");
  const context = companionTimeContext(now, now - 3 * 3_600_000);
  assert.match(context, /2026年09月01日/u);
  assert.match(context, /00:30/u);
  assert.match(context, /深夜/u);
  assert.match(context, /约 3 小时/u);
});

test("time context forbids guessing the user's routine or forcing a farewell", () => {
  const context = companionTimeContext(Date.parse("2026-08-31T15:00:00.000Z"));
  assert.match(context, /不能只凭时段断定/u);
  assert.match(context, /不要擅自说早安、晚安/u);
});

test("conversation gaps are bounded human-readable facts", () => {
  const now = 10 * 86_400_000;
  assert.equal(conversationGapText(now, null), "没有可用的上一轮发送时间");
  assert.equal(conversationGapText(now, now - 90_000), "不到 2 分钟");
  assert.equal(conversationGapText(now, now - 25 * 60_000), "约 25 分钟");
  assert.equal(conversationGapText(now, now - 2 * 3_600_000), "约 2 小时");
  assert.equal(conversationGapText(now, now - 3 * 86_400_000), "约 3 天");
});

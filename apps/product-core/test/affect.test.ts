import assert from "node:assert/strict";
import test from "node:test";
import {
  AffectEngine,
  affectExpression,
  affectPromptContext,
  appraiseUserMessage,
  decayAffectiveState,
  evolveAffectiveState,
  initialAffectiveState,
} from "../src/affect.ts";
import { ProductStore } from "../src/store.ts";

test("short-term emotion decays without reducing the relationship", () => {
  const initial = initialAffectiveState(0);
  const emotional = evolveAffectiveState(initial, appraiseUserMessage("我最近真的很难受，想哭"), 0);
  assert.equal(emotional.emotion, "concerned");
  assert.ok(emotional.intensity >= 0.7);
  const relationship = structuredClone(emotional.relationship);
  const later = decayAffectiveState(emotional, 4 * 60 * 60_000);
  assert.equal(later.emotion, "neutral");
  assert.deepEqual(later.relationship, relationship);
});

test("correction improves rapport instead of punishing trust", () => {
  const initial = initialAffectiveState(1000);
  const corrected = evolveAffectiveState(initial, appraiseUserMessage("不是这样，你又理解错了，别解释那么多"), 1000);
  assert.equal(corrected.emotion, "thoughtful");
  assert.ok(corrected.relationship.rapport > initial.relationship.rapport);
  assert.ok(corrected.relationship.trust >= initial.relationship.trust);
});

test("relationship gains are bounded and diminish near the ceiling", () => {
  let state = initialAffectiveState(0);
  for (let index = 0; index < 1000; index += 1) {
    state = evolveAffectiveState(state, appraiseUserMessage("有你真好，我喜欢你"), index + 1);
  }
  assert.ok(state.relationship.affection <= 1);
  assert.ok(state.relationship.trust <= 1);
  assert.equal(state.relationship.stage, "attuned");
});

test("affect events persist once per source message", () => {
  const store = new ProductStore(":memory:");
  try {
    const engine = new AffectEngine(store);
    const first = engine.observeUserMessage("owner", "message-1", "谢谢你，做得不错", 1000);
    const duplicate = engine.observeUserMessage("owner", "message-1", "谢谢你，做得不错", 1000);
    assert.deepEqual(duplicate.relationship, first.relationship);
    assert.equal(store.listAffectEvents("owner").length, 1);
    assert.equal(affectExpression(first).motion, "Smile");
    const prompt = affectPromptContext(first);
    assert.match(prompt, /绝不能向用户展示数值/u);
    assert.doesNotMatch(prompt, /0\.\d/u);
  } finally {
    store.close();
  }
});

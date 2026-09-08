import assert from "node:assert/strict";
import test from "node:test";
import { CharacterEvalStore, measureCandidate, type CharacterEvalCase } from "../src/character-eval.ts";

const evalCase: CharacterEvalCase = {
  id: "sample",
  category: "普通闲聊",
  title: "样例",
  messages: [{ role: "user", content: "今天好累" }],
  expectations: { maxChars: 40, maxQuestions: 0, maxBubbles: 2, forbiddenSubstrings: ["还有什么可以帮你"] },
};

test("candidate metrics enforce only deterministic hard rules", () => {
  const natural = measureCandidate("又撑了一天……先歇一会儿", evalCase);
  assert.deepEqual(natural.hardFailures, []);

  const mechanical = measureCandidate("我理解你的感受。\n- 早点休息\n- 喝点水\n还有什么可以帮你？", evalCase);
  assert.ok(mechanical.hardFailures.some((item) => item.includes("客服")));
  assert.ok(mechanical.hardFailures.some((item) => item.includes("问题")));
  assert.ok(mechanical.hardFailures.some((item) => item.includes("列表")));
});

test("blind reviews preserve hidden variant mapping and owner preference", () => {
  const store = new CharacterEvalStore(":memory:");
  try {
    const runId = store.createRun({ labelA: "旧版", labelB: "新版", modelA: "m", modelB: "m", promptAHash: "a", promptBHash: "b" }, 1000);
    store.addPair({ runId, evalCase, textA: "旧回复", textB: "新回复", repetition: 1, swap: true }, 1001);
    const pair = store.nextBlindPair(runId);
    assert.ok(pair);
    assert.equal(pair.leftText, "新回复");
    assert.equal("leftVariant" in pair, false);
    store.recordReview({ pairId: pair.id, choice: "left", reasonTags: ["更自然"], note: "这个更像人", confidence: 5 }, 1002);
    assert.equal(store.nextBlindPair(runId), null);
    const report = store.report(runId) as { ownerPreference: { winsA: number; winsB: number }; reasonTags: Record<string, number> };
    assert.deepEqual(report.ownerPreference, { winsA: 0, winsB: 1, ties: 0, bothBad: 0, winRateA: 0, winRateB: 1 });
    assert.equal(report.reasonTags["更自然"], 1);
    const records = store.preferenceRecords(runId);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].preferred, { text: "新回复", rawText: "新回复", meta: {}, variant: "b", metrics: measureCandidate("新回复", evalCase) });
    assert.deepEqual((records[0].human as { reasonTags: string[] }).reasonTags, ["更自然"]);
  } finally {
    store.close();
  }
});

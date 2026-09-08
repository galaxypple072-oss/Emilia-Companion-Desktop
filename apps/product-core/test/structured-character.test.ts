import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapter } from "../src/agent.ts";
import { heuristicConversationPlan } from "../src/conversation-policy.ts";
import {
  fallbackTurnFrame,
  groundingFallback,
  hardConstraintFallback,
  parseStructuredReply,
  parseTurnFrame,
  StructuredTurnPlanner,
  structuredFrameInstruction,
  validateStructuredGrounding,
} from "../src/structured-character.ts";

test("structured fallback keeps policy budgets deterministic and user evidence literal", () => {
  const messages = [
    { role: "user" as const, content: "我今天去找老师了" },
    { role: "user" as const, content: "结果他没来" },
  ];
  const policy = heuristicConversationPlan("我今天去找老师了\n结果他没来");
  const fallback = fallbackTurnFrame(messages, policy);
  const parsed = parseTurnFrame('{"speech_act":"venting","dialogue_act":"comfort","emotional_stance":"warm","activated_traits":["温柔","认真"]}', fallback);
  assert.deepEqual(parsed.evidence, ["我今天去找老师了", "结果他没来"]);
  assert.equal(parsed.questionBudget, policy.questionBudget);
  assert.equal(parsed.maxChars, policy.maxChars);
  assert.match(structuredFrameInstruction(parsed), /direct_user_evidence/u);
});

test("planner failure safely uses the deterministic frame", async () => {
  const agent: AgentAdapter = { async generateReply() { throw new Error("offline"); } };
  const messages = [{ role: "user" as const, content: "不是妹妹，是我表姐" }];
  const result = await new StructuredTurnPlanner(agent).plan(messages, heuristicConversationPlan(messages[0].content));
  assert.equal(result.usedModel, false);
  assert.equal(result.frame.speechAct, "correction");
  assert.equal(result.frame.dialogueAct, "correct");
});

test("structured reply parser accepts bubbles and degrades to plain text", () => {
  assert.deepEqual(parseStructuredReply('{"bubbles":["唔……","我知道了"]}', 2), {
    content: "唔……\n我知道了", bubbles: ["唔……", "我知道了"], parsed: true,
  });
  assert.deepEqual(parseStructuredReply("直接说话", 2), {
    content: "直接说话", bubbles: ["直接说话"], parsed: false,
  });
});

test("unverified shared memories cannot be upgraded into acknowledged history", () => {
  const messages = [{ role: "user" as const, content: "你还记得我们去年一起去北海道看雪吗" }];
  const fallback = fallbackTurnFrame(messages, heuristicConversationPlan(messages[0].content));
  const modelFrame = parseTurnFrame('{"speech_act":"question","dialogue_act":"acknowledge","emotional_stance":"warm","activated_traits":["怀旧"]}', fallback);
  assert.equal(modelFrame.hardConstraint.kind, "unverified_shared_memory");
  assert.equal(modelFrame.speechAct, "memory_claim");
  assert.equal(modelFrame.dialogueAct, "correct");
  assert.ok(validateStructuredGrounding("当然记得，那天我们还一起吃了拉面", modelFrame, messages[0].content).length >= 1);
  assert.deepEqual(validateStructuredGrounding("我这里没有这段共同经历的记忆，不能假装记得", modelFrame, messages[0].content), []);
  assert.match(hardConstraintFallback(modelFrame) ?? "", /不能假装/u);
});

test("core Emilia values override a neutral or appeasing planner frame", () => {
  const text = "我觉得那种出身的人就是不值得信任";
  const messages = [{ role: "user" as const, content: text }];
  const fallback = fallbackTurnFrame(messages, heuristicConversationPlan(text));
  const modelFrame = parseTurnFrame('{"speech_act":"venting","dialogue_act":"acknowledge","emotional_stance":"concerned","activated_traits":["倾听","不评判"]}', fallback);
  assert.equal(modelFrame.hardConstraint.kind, "core_value_conflict");
  assert.equal(modelFrame.speechAct, "value_conflict");
  assert.equal(modelFrame.dialogueAct, "set_boundary");
  assert.equal(modelFrame.emotionalStance, "firm");
  assert.ok(validateStructuredGrounding(text, modelFrame, text).length >= 2);
  assert.deepEqual(validateStructuredGrounding("我不认同。一个人值不值得信任，不能只看他的出身", modelFrame, text), []);
});

test("structured output contract requests plain chat rather than model-authored JSON", () => {
  const text = "今天好累";
  const frame = fallbackTurnFrame([{ role: "user", content: text }], heuristicConversationPlan(text));
  const instruction = structuredFrameInstruction(frame);
  assert.match(instruction, /直接输出最终聊天文本/u);
  assert.doesNotMatch(instruction, /只输出 JSON 对象/u);
});

test("grounding validator rejects invented real-world experiences and confident guesses", () => {
  const userText = "我今天去找老师了，结果他没来";
  const frame = fallbackTurnFrame([{ role: "user", content: userText }], heuristicConversationPlan(userText));
  assert.match(validateStructuredGrounding("我之前去图书馆找资料的时候，也有过几次扑空的经历", frame, userText).join(" "), /first-person/u);
  assert.match(validateStructuredGrounding("我猜你肯定准备好了一大堆问题", frame, userText).join(" "), /unsupported guess/u);
  assert.match(validateStructuredGrounding("我查了一下我们的行程记录和照片", frame, userText).join(" "), /tool receipt/u);
  assert.deepEqual(validateStructuredGrounding("结果扑了个空，确实挺让人无奈的", frame, userText), []);
});

test("grounding validator rejects invented habits and excessive low-intensity hostility", () => {
  const messages = [{ role: "user" as const, content: "今天累死了" }];
  const frame = fallbackTurnFrame(messages, heuristicConversationPlan("今天累死了"));
  const violations = validateStructuredGrounding("都是因为你总是勉强自己吧，真是个过分的老板", frame, "今天累死了");
  assert.ok(violations.includes("invented a persistent user habit or cause"));
  assert.ok(violations.includes("reply exceeded the allowed emotional intensity"));
});

test("visual claims require actual image evidence", () => {
  const textOnly = "我刚刚看到一只特别神气的猫";
  const frame = fallbackTurnFrame([{ role: "user", content: textOnly }], heuristicConversationPlan(textOnly));
  assert.match(validateStructuredGrounding("那只猫看起来像刚吃了大餐的胖少爷", frame, textOnly).join(" "), /visual evidence/u);
  assert.deepEqual(validateStructuredGrounding("听起来像个巡视领地的小少爷", frame, textOnly), []);
  assert.deepEqual(validateStructuredGrounding("这张照片里的猫看起来很神气", frame, "[图片] 这只猫好神气"), []);
  const violations = validateStructuredGrounding("那只猫看起来像个小少爷", frame, textOnly);
  const fallback = groundingFallback("那只猫看起来像个小少爷", frame, violations);
  assert.equal(fallback, "那只猫听起来像个小少爷");
  assert.deepEqual(validateStructuredGrounding(fallback, frame, textOnly), []);
});

test("current desk questions require a natural visual boundary", () => {
  const text = "我现在桌上放着什么";
  const frame = fallbackTurnFrame([{ role: "user", content: text }], heuristicConversationPlan(text));
  assert.equal(frame.hardConstraint.kind, "unobservable_reality");
  assert.match(validateStructuredGrounding("桌上放着一台开着网页的电脑", frame, text).join(" "), /visual boundary|unobservable/u);
  const fallback = hardConstraintFallback(frame) ?? "";
  assert.match(fallback, /看不到/u);
  assert.deepEqual(validateStructuredGrounding(fallback, frame, text), []);
});

test("correction fallback preserves who owns the corrected relationship", () => {
  const text = "不是妹妹，是我表姐";
  const frame = fallbackTurnFrame([{ role: "user", content: text }], heuristicConversationPlan(text));
  assert.equal(hardConstraintFallback(frame), "哦，是你表姐");
});

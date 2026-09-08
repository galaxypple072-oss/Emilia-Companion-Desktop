import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapter } from "../src/agent.ts";
import {
  ConversationPolicyService,
  detectStyleFeedback,
  finalBehaviorInstruction,
  heuristicConversationPlan,
  parseConversationPlan,
  reviewConversationReply,
} from "../src/conversation-policy.ts";
import { ProductStore } from "../src/store.ts";

test("casual and emotional turns default to statements with no question budget", () => {
  const casual = heuristicConversationPlan("老板又给我加活了", []);
  assert.equal(casual.intent, "vent");
  assert.equal(casual.questionBudget, 0);
  assert.equal(casual.move, "tease");
  assert.match(finalBehaviorInstruction(casual), /不追加维持对话的问题/u);

  const question = heuristicConversationPlan("这个为什么会失败？", []);
  assert.equal(question.intent, "question");
  assert.equal(question.questionBudget, 0);
});

test("clarification is limited to one task question and respects cooldown", () => {
  const fallback = heuristicConversationPlan("帮我发邮件", []);
  const output = '{"intent":"task","move":"ask","needs_clarification":true,"max_chars":50,"reason":"缺少收件人"}';
  assert.equal(parseConversationPlan(output, fallback, []).questionBudget, 1);
  assert.equal(parseConversationPlan(output, fallback, ["你要发给谁？"]).questionBudget, 0);
});

test("genuine casual curiosity is cadence-limited instead of forbidden forever", () => {
  const fallback = heuristicConversationPlan("我今天发现一家很奇怪的小店", []);
  const output = '{"intent":"casual","move":"ask","needs_clarification":false,"genuine_curiosity":true,"max_chars":40,"reason":"对具体新鲜细节感兴趣"}';
  assert.equal(parseConversationPlan(output, fallback, []).questionBudget, 1);
  assert.equal(parseConversationPlan(output, fallback, ["嗯。", "原来如此。", "这倒挺新鲜。"] ).questionBudget, 1);
  assert.equal(parseConversationPlan(output, fallback, ["嗯。", "然后呢？", "这倒挺新鲜。"] ).questionBudget, 0);
});

test("planner cannot upgrade ordinary sharing into a tool-bearing task", () => {
  const fallback = heuristicConversationPlan("我今天尝试了一件新事", []);
  const output = '{"intent":"task","move":"act","needs_clarification":false,"max_chars":80,"reason":"misread as request"}';
  const plan = parseConversationPlan(output, fallback, []);
  assert.equal(plan.intent, "casual");
  assert.notEqual(plan.move, "act");
});

test("review catches question addiction and service tone", () => {
  const plan = heuristicConversationPlan("今天好累", []);
  assert.ok(reviewConversationReply("我理解你的感受。你现在感觉怎么样？要不要休息？", plan).length >= 2);
  assert.deepEqual(reviewConversationReply("又撑了一整天……先坐一会儿。", plan), []);
});

test("ordinary chat enforces its actual short-message budget", () => {
  const plan = heuristicConversationPlan("今天好累");
  assert.match(reviewConversationReply("你真的已经撑了很久，我看着也会担心。以后不管再怎么忙都一定要好好休息，千万不能让自己继续这样累下去了，工作再重要也没有你自己重要，所以今天无论如何都不许再继续勉强自己。", plan).join(" "), /length budget/u);
});

test("review catches disguised questions without question marks", () => {
  const plan = heuristicConversationPlan("今天累死了");
  assert.deepEqual(reviewConversationReply("这么累啊……要不要先靠一会儿，别硬撑着。", plan), [
    "implicit question clause used despite zero question budget",
  ]);
});

test("review catches question particles disguised with a full stop", () => {
  const plan = heuristicConversationPlan("我刚刚看到一只猫");
  assert.match(reviewConversationReply("你平时也会留意小动物吗。", plan).join(" "), /implicit question clause/u);
  assert.match(reviewConversationReply("唔……是什么样的猫咪呀。", plan).join(" "), /implicit question clause/u);
  assert.match(reviewConversationReply("看起来一点力气都没有了吧。", plan).join(" "), /implicit question clause/u);
  assert.match(reviewConversationReply("真让人火大。他怎么总是盯着你不放呢。", plan).join(" "), /implicit question clause/u);
  assert.match(reviewConversationReply("特别神气。它当时的样子怎么样。", plan).join(" "), /implicit question clause/u);
  assert.match(reviewConversationReply("诶。它看起来是什么样子的呀。", plan).join(" "), /implicit question clause/u);
  assert.match(reviewConversationReply("诶，那只猫长什么样啊。", plan).join(" "), /implicit question clause/u);
});

test("deterministically removes character-model protocol leaks and stage directions", async () => {
  const plan = heuristicConversationPlan("今天累死了");
  const policy = new ConversationPolicyService();
  const result = await policy.enforce(
    "intent=vent; conversation_move=tease; reply_max_chars=60.\n（正盯着屏幕整理文件，看到消息转过头来）这么快又倒下了。",
    plan,
    "今天累死了",
  );
  assert.equal(result.text, "这么快又倒下了。");
  assert.equal(result.rewritten, true);
});

test("deterministically removes forced animal-sound cuteness", async () => {
  const plan = heuristicConversationPlan("我看到一只猫");
  const policy = new ConversationPolicyService();
  const result = await policy.enforce("喵~ 看起来它一定很厉害呢。", plan);
  assert.equal(result.text, "看起来它一定很厉害呢。");
  assert.equal(result.rewritten, true);
});

test("deterministically removes implicit hook questions before model rewriting", async () => {
  const plan = heuristicConversationPlan("我看到一只特别神气的猫");
  const policy = new ConversationPolicyService({
    async generateReply() { throw new Error("rewriter should not run"); },
  });
  const result = await policy.enforce("好好奇……是在晒太阳还是在散步啊", plan);
  assert.equal(result.text, "好好奇……");
});

test("policy rewrites a violating draft and preserves a natural statement", async () => {
  const responses = ["又被加活了……他是真的把你一天当四十八小时用了。"];
  const agent: AgentAdapter = { async generateReply() { return responses.shift()!; } };
  const service = new ConversationPolicyService(agent);
  const plan = heuristicConversationPlan("老板又给我加活了", []);
  const result = await service.enforce("你感觉怎么样？要不要我帮你？", plan);
  assert.equal(result.rewritten, true);
  assert.equal(result.text.includes("？"), false);
});

test("detects explicit style feedback without treating it as ordinary memory", () => {
  const feedback = detectStyleFeedback("别每句话都问我问题，也不要说那么长，真的很像客服");
  assert.deepEqual(feedback.map((item) => item.category), ["questions", "verbosity", "service_tone"]);
  assert.equal(detectStyleFeedback("这样说就挺自然")[0].sentiment, "positive");
});

test("persona epochs isolate old assistant style while preserving new turns", () => {
  const store = new ProductStore(":memory:");
  try {
    store.recordInbound({ channel: "qq", externalMessageId: "old-user", senderId: "1", body: "旧消息", receivedAt: 1000 });
    const oldId = store.enqueue({ recipientId: "1", body: "旧的追问？", dueAt: 1000 });
    store.claimDue(1000);
    store.markSent(oldId, "old-assistant", 1000);
    const epoch = store.ensurePersonaEpoch("v-next", 2000);
    store.recordInbound({ channel: "qq", externalMessageId: "new-user", senderId: "1", body: "新消息", receivedAt: 3000 });
    assert.deepEqual(store.recentConversation("1", 20, epoch), [{ role: "user", content: "新消息" }]);
    assert.deepEqual(store.recentAssistantMessages("1", 4, epoch), []);
  } finally {
    store.close();
  }
});

test("style feedback is deduplicated and compiled into high-priority context", () => {
  const store = new ProductStore(":memory:");
  try {
    assert.equal(store.recordStyleFeedback({
      category: "questions", sentiment: "negative", instruction: "减少提问。", sourceMessageId: "m1", now: 1000,
    }), true);
    assert.equal(store.recordStyleFeedback({
      category: "questions", sentiment: "negative", instruction: "减少提问。", sourceMessageId: "m1", now: 1001,
    }), false);
    assert.match(store.stylePreferenceContext(), /减少提问/u);
    store.recordDialogueAudit({
      sourceMessageId: "m2", intent: "casual", move: "react", questionBudget: 0,
      maxChars: 60, rewritten: true, violations: ["question count"], finalText: "知道了。", now: 2000,
    });
    assert.deepEqual(store.dialoguePolicySummary(), {
      turns: 1, rewritten: 1, turns_with_questions: 0, average_length: 4,
    });
  } finally {
    store.close();
  }
});

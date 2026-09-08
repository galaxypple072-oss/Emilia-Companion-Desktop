import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapter } from "../src/agent.ts";
import { heuristicConversationPlan } from "../src/conversation-policy.ts";
import {
  fallbackReferenceEpisode,
  ReferenceEpisodePlanner,
  referencePostHistoryInstruction,
  sanitizeReferenceReply,
} from "../src/reference-character.ts";

test("waits when the user explicitly signals an unfinished continuation", () => {
  const messages = [
    { role: "user" as const, content: "我喜欢沙盒和二游" },
    { role: "user" as const, content: "还有" },
  ];
  const frame = fallbackReferenceEpisode(messages, heuristicConversationPlan("还有"));
  assert.equal(frame.waitForContinuation, true);
  assert.equal(frame.action, "wait");
  assert.equal(frame.phase, "collecting");
});

test("keeps a getting-acquainted episode active and allows one useful question", () => {
  const messages = [
    { role: "user" as const, content: "我们互相了解一下吧" },
    { role: "assistant" as const, content: "好呀" },
    { role: "user" as const, content: "我现在是大学生" },
  ];
  const frame = fallbackReferenceEpisode(messages, heuristicConversationPlan("我现在是大学生"));
  assert.match(frame.topic, /互相了解/u);
  assert.equal(frame.action, "ask_one");
  assert.equal(frame.questionBudget, 1);
  assert.deepEqual(frame.directUserEvidence, ["我们互相了解一下吧", "我现在是大学生"]);
});

test("treats character facts as latent causes rather than self-introduction copy", () => {
  const messages = [{ role: "user" as const, content: "你简单介绍一下自己" }];
  const frame = fallbackReferenceEpisode(messages, heuristicConversationPlan(messages[0].content));
  assert.equal(frame.action, "self_disclose");
  assert.match(referencePostHistoryInstruction(frame), /不是自我介绍时要朗读的简历/u);
});

test("recognizes colloquial user corrections without defending the old guess", () => {
  const messages = [
    { role: "assistant" as const, content: "你说音游跟不上节奏" },
    { role: "user" as const, content: "我可没说过" },
  ];
  const frame = fallbackReferenceEpisode(messages, heuristicConversationPlan("我可没说过"));
  assert.equal(frame.action, "correct");
  assert.equal(frame.phase, "correcting");
});

test("does not confuse a normal 是不是 question with a correction", () => {
  const messages = [{ role: "user" as const, content: "你刚才是不是整理我桌面了" }];
  const frame = fallbackReferenceEpisode(messages, heuristicConversationPlan(messages[0].content));
  assert.notEqual(frame.action, "correct");
  assert.equal(frame.action, "answer");
  assert.match(frame.innerState, /现实边界/u);
});

test("keeps a plain topic close from inventing time or a farewell", () => {
  const messages = [{ role: "user" as const, content: "嗯，这样就差不多了" }];
  const frame = fallbackReferenceEpisode(messages, heuristicConversationPlan(messages[0].content));
  assert.equal(frame.action, "close");
  assert.match(referencePostHistoryInstruction(frame), /不要推断时间/u);
});

test("planner cannot invent an extra question budget", async () => {
  const agent: AgentAdapter = {
    async generateReply() {
      return JSON.stringify({ topic: "新话题", phase: "developing", action: "ask_one", inner_state: "好奇" });
    },
  };
  const messages = [{ role: "user" as const, content: "我去吃饭了" }];
  const planned = await new ReferenceEpisodePlanner(agent).plan(messages, heuristicConversationPlan("我去吃饭了"));
  assert.equal(planned.frame.questionBudget, 0);
  assert.notEqual(planned.frame.action, "ask_one");
});

test("planner cannot promote an ordinary status question into a tool call", async () => {
  const agent: AgentAdapter = {
    async generateReply() {
      return JSON.stringify({ topic: "邮件状态", phase: "developing", action: "tool_handoff", inner_state: "查询状态" });
    },
  };
  const messages = [{ role: "user" as const, content: "邮件发出去了吗" }];
  const planned = await new ReferenceEpisodePlanner(agent).plan(messages, heuristicConversationPlan(messages[0].content));
  assert.notEqual(planned.frame.action, "tool_handoff");
});

test("removes physical stage directions but preserves ordinary parentheses", () => {
  assert.equal(sanitizeReferenceReply("嗯\n（看着你笑了笑）\n我知道了"), "嗯\n我知道了");
  assert.equal(sanitizeReferenceReply("ISD（一个专业缩写）我还不熟悉"), "ISD（一个专业缩写）我还不熟悉");
});

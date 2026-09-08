import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapter, AgentRequest } from "../src/agent.ts";
import { EMILIA_SYSTEM_PROMPT } from "../src/persona.ts";
import { loadRoleplayConfig, roleplayEligible, roleplayIntent, RoleplayRoutingAgent } from "../src/roleplay-agent.ts";
import { REFERENCE_NO_REPLY } from "../src/reference-character.ts";

test("loads an opt-in roleplay configuration without reusing the primary key", () => {
  assert.equal(loadRoleplayConfig({}), null);
  const config = loadRoleplayConfig({ ROLEPLAY_ENABLED: "true", ROLEPLAY_API_KEY: "role-secret" });
  assert.equal(config?.model, "qwen-flash-character-2026-02-26");
  assert.equal(config?.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(config?.apiKey, "role-secret");
  assert.throws(() => loadRoleplayConfig({ ROLEPLAY_ENABLED: "true" }), /ROLEPLAY_API_KEY/u);
});

test("routes only non-operational emotional chat to the roleplay model", async () => {
  const calls: string[] = [];
  const adapter = (name: string): AgentAdapter => ({
    async generateReply(request) {
      calls.push(name);
      if (name === "roleplay") {
        assert.equal(request.finalInstruction, undefined);
        assert.match(request.systemPrompt, /不是小说/u);
        assert.match(request.systemPrompt, /intent=vent/u);
        assert.match(request.systemPrompt, /用户就是用户本人，不是昴/u);
        assert.doesNotMatch(request.systemPrompt, /【语感示例】/u);
      }
      return name;
    },
  });
  const routed = new RoleplayRoutingAgent(adapter("primary"), adapter("roleplay"));
  const request = (intent: string): AgentRequest => ({
    systemPrompt: EMILIA_SYSTEM_PROMPT,
    messages: [{ role: "user", content: "hello" }],
    finalInstruction: `intent=${intent}; conversation_move=react; reply_max_chars=60.`,
  });
  assert.equal(roleplayEligible(request("casual")), true);
  assert.equal(roleplayEligible(request("task")), false);
  assert.equal(await routed.generateReply(request("vent")), "roleplay");
  assert.equal(await routed.generateReply(request("task")), "primary");
  assert.deepEqual(calls, ["roleplay", "primary"]);
});

test("recognizes the production Chinese behavior contract", () => {
  const request: AgentRequest = {
    systemPrompt: EMILIA_SYSTEM_PROMPT,
    messages: [{ role: "user", content: "今天还挺开心" }],
    finalInstruction: "本轮意图：casual；主要对话动作：react；建议长度上限：60 字。",
  };
  assert.equal(roleplayIntent(request), "casual");
  assert.equal(roleplayEligible(request), true);
});

test("keeps legacy surface voice for casual chat and adds guardrails only when needed", async () => {
  const prompts: string[] = [];
  const primary: AgentAdapter = { async generateReply() { return "primary"; } };
  const roleplay: AgentAdapter = { async generateReply(request) { prompts.push(request.systemPrompt); return "嗯，确实挺有意思的"; } };
  const routed = new RoleplayRoutingAgent(primary, roleplay);
  const base = {
    systemPrompt: EMILIA_SYSTEM_PROMPT,
    messages: [{ role: "user" as const, content: "今天看到一只猫" }],
  };
  assert.equal(await routed.generateReply({ ...base, conversation: { intent: "casual", move: "react", questionBudget: 0, maxChars: 60 } }), "嗯，确实挺有意思的");
  assert.doesNotMatch(prompts[0], /本轮事实与角色边界/u);
  await routed.generateReply({ ...base, messages: [{ role: "user", content: "今天难受得想哭" }], conversation: { intent: "emotional", move: "acknowledge", questionBudget: 0, maxChars: 60 } });
  assert.match(prompts[1], /本轮事实与角色边界/u);
  assert.match(prompts[1], /情绪强度：2\/2/u);
  assert.match(prompts[1], /不要因为这段规则变得强势/u);
});

test("repairs an invented fact once before returning a roleplay reply", async () => {
  let calls = 0;
  const roleplay: AgentAdapter = {
    async generateReply(request) {
      calls += 1;
      if (calls === 1) return "我刚刚也在图书馆看到了";
      assert.match(request.systemPrompt, /草稿纠错/u);
      return "听起来还挺巧的";
    },
  };
  const routed = new RoleplayRoutingAgent({ async generateReply() { return "primary"; } }, roleplay);
  const reply = await routed.generateReply({
    systemPrompt: EMILIA_SYSTEM_PROMPT,
    messages: [{ role: "user", content: "我刚从图书馆回来" }],
    conversation: { intent: "casual", move: "react", questionBudget: 0, maxChars: 60 },
  });
  assert.equal(reply, "听起来还挺巧的");
  assert.equal(calls, 2);
});

test("routes an unverified shared-memory question through the guarded character path", async () => {
  const prompts: string[] = [];
  const routed = new RoleplayRoutingAgent(
    { async generateReply() { return "primary"; } },
    { async generateReply(request) { prompts.push(request.systemPrompt); return "我这里没有这段可靠记忆，不能假装记得"; } },
  );
  const reply = await routed.generateReply({
    systemPrompt: EMILIA_SYSTEM_PROMPT,
    messages: [{ role: "user", content: "你还记得我们去年一起去海边吗" }],
    conversation: { intent: "question", move: "opinion", questionBudget: 0, maxChars: 60 },
    grounding: { verifiedMemories: [] },
  });
  assert.match(reply, /没有这段可靠记忆/u);
  assert.match(prompts[0], /不能假装记得/u);
});

test("falls back to the primary model when the roleplay endpoint fails", async () => {
  const primary: AgentAdapter = { async generateReply() { return "fallback"; } };
  const roleplay: AgentAdapter = { async generateReply() { throw new Error("offline"); } };
  const routed = new RoleplayRoutingAgent(primary, roleplay);
  const reply = await routed.generateReply({
    systemPrompt: "persona",
    messages: [{ role: "user", content: "今天好累" }],
    finalInstruction: "intent=emotional; conversation_move=acknowledge; reply_max_chars=60.",
  });
  assert.equal(reply, "fallback");
});

test("keeps an explicitly unfinished episode silent", async () => {
  const routed = new RoleplayRoutingAgent(
    { async generateReply() { return "primary"; } },
    { async generateReply() { return "roleplay"; } },
  );
  const reply = await routed.generateReply({
    systemPrompt: EMILIA_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: "我喜欢沙盒和二游" },
      { role: "user", content: "还有" },
    ],
    conversation: { intent: "casual", move: "react", questionBudget: 0, maxChars: 60 },
  });
  assert.equal(reply, REFERENCE_NO_REPLY);
});

test("places the episode workspace behind the existing character voice", async () => {
  const prompts: string[] = [];
  const routed = new RoleplayRoutingAgent(
    { async generateReply() { return "primary"; } },
    { async generateReply(request) { prompts.push(request.systemPrompt); return "听起来挺有意思的"; } },
  );
  await routed.generateReply({
    systemPrompt: EMILIA_SYSTEM_PROMPT,
    messages: [{ role: "user", content: "刚刚看到一只很神气的猫" }],
    conversation: { intent: "casual", move: "react", questionBudget: 0, maxChars: 60 },
  });
  assert.match(prompts[0], /当前意识工作区/u);
  assert.match(prompts[0], /刚刚看到一只很神气的猫/u);
});

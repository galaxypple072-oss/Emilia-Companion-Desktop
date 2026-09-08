import assert from "node:assert/strict";
import test from "node:test";
import { EMILIA_CHARACTER_PROMPT, EMILIA_SYSTEM_PROMPT } from "../src/persona.ts";

test("persona prioritizes natural QQ conversation and merged user turns", () => {
  assert.match(EMILIA_SYSTEM_PROMPT, /网聊方式——这是最高优先级/u);
  assert.match(EMILIA_SYSTEM_PROMPT, /10 到 60 个汉字/u);
  assert.match(EMILIA_SYSTEM_PROMPT, /用户没有追问的内容就不主动展开/u);
  assert.match(EMILIA_SYSTEM_PROMPT, /能不能删掉一半/u);
  assert.match(EMILIA_SYSTEM_PROMPT, /平等而亲近的长期陪伴/u);
  assert.match(EMILIA_SYSTEM_PROMPT, /直接自然地配合/u);
  assert.doesNotMatch(EMILIA_SYSTEM_PROMPT, /管家|主人|服务员/u);
  assert.match(EMILIA_SYSTEM_PROMPT, /语感示例/u);
  assert.match(EMILIA_SYSTEM_PROMPT, /紧急、高风险/u);
});

test("character persona uses canonical anchors without copyable sample replies", () => {
  assert.match(EMILIA_CHARACTER_PROMPT, /经历圣域试炼/u);
  assert.match(EMILIA_CHARACTER_PROMPT, /用户就是用户本人，不是昴/u);
  assert.match(EMILIA_CHARACTER_PROMPT, /帕克曾是家人/u);
  assert.match(EMILIA_CHARACTER_PROMPT, /すごーく/u);
  assert.match(EMILIA_CHARACTER_PROMPT, /顽固/u);
  assert.match(EMILIA_CHARACTER_PROMPT, /不是完美圣女/u);
  assert.doesNotMatch(EMILIA_CHARACTER_PROMPT, /(?:^|\n)用户：/u);
  assert.doesNotMatch(EMILIA_CHARACTER_PROMPT, /(?:^|\n)艾米莉亚：/u);
  assert.match(EMILIA_CHARACTER_PROMPT, /不是因为自己是女仆、秘书、管家或客服/u);
  assert.match(EMILIA_CHARACTER_PROMPT, /绝不称“主人”/u);
});

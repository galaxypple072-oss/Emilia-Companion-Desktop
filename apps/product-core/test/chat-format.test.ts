import assert from "node:assert/strict";
import test from "node:test";
import { formatQqReply, qqBubbleOffsets } from "../src/chat-format.ts";

test("keeps casual replies short and limits bubble count without discarding the ending", () => {
  const reply = Array.from({ length: 12 }, (_, index) => `这是第${index + 1}句比较啰嗦的话。`).join("");
  const chunks = formatQqReply(reply, "今天好累");
  assert.ok(chunks.length <= 4);
  assert.ok(chunks.every((chunk) => chunk.length <= 60));
  assert.match(chunks.at(-1) ?? "", /第12句/u);
});

test("preserves short natural paragraphs as separate QQ bubbles", () => {
  assert.deepEqual(formatQqReply("我知道了。\n\n先休息一会儿吧。", "今天好累"), ["我知道了", "先休息一会儿吧"]);
});

test("splits ordinary consecutive sentences into natural QQ bubbles", () => {
  assert.deepEqual(formatQqReply("又给你加活了。他是真把你当整个部门用了。先喘口气。", "老板又来了"), [
    "又给你加活了",
    "他是真把你当整个部门用了",
    "先喘口气",
  ]);
});

test("drops formal full stops from casual QQ bubbles but keeps expressive punctuation", () => {
  assert.deepEqual(formatQqReply("知道了。真的？好耶！", "随便聊聊"), ["知道了", "真的？", "好耶！"]);
});

test("uses human-like bounded delays between QQ bubbles", () => {
  assert.deepEqual(qqBubbleOffsets(4, () => 0), [0, 550, 1100, 1650]);
  assert.deepEqual(qqBubbleOffsets(3, () => 0.999999), [0, 1300, 2600]);
});

test("allows larger chunks for explicitly complex requests", () => {
  const long = "详细内容。".repeat(80);
  const chunks = formatQqReply(long, "请给我一个详细的技术方案");
  assert.equal(chunks.join(""), long);
});

test("does not treat ordinary tool or how-to wording as permission for a long answer", () => {
  const long = "额外解释。".repeat(80);
  assert.ok(formatQqReply(long, "帮我看看邮件").join("").length < long.length);
  assert.ok(formatQqReply(long, "这个怎么做").length <= 4);
});

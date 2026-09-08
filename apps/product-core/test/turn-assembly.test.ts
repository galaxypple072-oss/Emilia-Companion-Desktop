import assert from "node:assert/strict";
import test from "node:test";
import { isLikelyQqSticker, isOnlyEmojiMessage, replyQuietWindowMs } from "../src/turn-assembly.ts";

test("extends the quiet window for obvious continuation fragments", () => {
  assert.equal(replyQuietWindowMs("而且还有一件事"), 5500);
  assert.equal(replyQuietWindowMs("主要是……"), 5500);
  assert.equal(replyQuietWindowMs("今天真的好累"), 3500);
});

test("recognizes emoji-only messages without suppressing ordinary text", () => {
  assert.equal(isOnlyEmojiMessage("😂😂"), true);
  assert.equal(isOnlyEmojiMessage("👩‍💻 ✨"), true);
  assert.equal(isOnlyEmojiMessage("笑死😂"), false);
});

test("uses OneBot native metadata to recognize standalone custom stickers", () => {
  assert.equal(isLikelyQqSticker({ file: "a.gif", summary: "[动画表情]", subType: 1 }, ""), true);
  assert.equal(isLikelyQqSticker({ file: "photo.jpg", summary: "[图片]" }, ""), false);
  assert.equal(isLikelyQqSticker({ file: "a.gif", summary: "[动画表情]", subType: 1 }, "记住这个表情包"), false);
});

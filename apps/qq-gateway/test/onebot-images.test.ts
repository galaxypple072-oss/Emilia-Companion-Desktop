import assert from "node:assert/strict";
import test from "node:test";
import { parseOneBotMessage } from "../src/onebot-images.ts";

test("extracts caption and first image from OneBot message segments", () => {
  assert.deepEqual(parseOneBotMessage([
    { type: "text", data: { text: "帮我看看" } },
    { type: "image", data: { file: "abc.jpg", url: "https://example.test/a.jpg" } },
    { type: "image", data: { file: "ignored.jpg" } },
  ]), {
    text: "帮我看看",
    image: { file: "abc.jpg", url: "https://example.test/a.jpg" },
    faces: [],
  });
});

test("falls back to CQ image syntax and decodes escaped values", () => {
  assert.deepEqual(parseOneBotMessage(undefined, "这是什么 [CQ:image,file=a&amp;b.jpg,url=https://example.test/a&#44;b]"), {
    text: "这是什么",
    image: { file: "a&b.jpg", url: "https://example.test/a,b" },
    faces: [],
  });
});

test("preserves QQ native custom sticker metadata", () => {
  assert.deepEqual(parseOneBotMessage([
    { type: "image", data: { file: "sticker.png", summary: "[动画表情]", sub_type: 1 } },
  ]), {
    text: "",
    image: { file: "sticker.png", summary: "[动画表情]", subType: 1 },
    faces: [],
  });
});

test("preserves native and CQ face segments as nonverbal input", () => {
  assert.deepEqual(parseOneBotMessage([
    { type: "face", data: { id: 14 } },
    { type: "text", data: { text: "哈哈" } },
  ]), { text: "哈哈", image: null, faces: [{ id: "14" }] });
  assert.deepEqual(parseOneBotMessage(undefined, "[CQ:face,id=66]"), {
    text: "",
    image: null,
    faces: [{ id: "66" }],
  });
});

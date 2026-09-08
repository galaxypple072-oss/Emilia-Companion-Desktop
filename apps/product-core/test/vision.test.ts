import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { DeepSeekVisionAdapter, detectImageMediaType, prepareVisionImage, type VisionConfig } from "../src/vision.ts";

const config: VisionConfig = {
  baseUrl: "https://example.test",
  apiKey: "vision-secret",
  model: "deepseek-v4-flash-vision-exp",
  maxTokens: 1200,
  timeoutMs: 10_000,
  maxImageBytes: 1024,
};

test("sends an image data URL to the configured vision model", async () => {
  let body: Record<string, unknown> = {};
  const fakeFetch: typeof fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer vision-secret");
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "一只猫" } }] }));
  };
  const result = await new DeepSeekVisionAdapter(config, fakeFetch).analyze(
    { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), mediaType: "image/jpeg" },
    "描述图片",
  );
  assert.equal(result, "一只猫");
  assert.equal(body.model, "deepseek-v4-flash-vision-exp");
  assert.deepEqual(body.thinking, { type: "disabled" });
  const messages = body.messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
  assert.match(messages[0].content[1].image_url!.url, /^data:image\/jpeg;base64,/u);
});

test("detects supported image formats by magic bytes", () => {
  assert.equal(detectImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff])), "image/jpeg");
  assert.equal(detectImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])), "image/png");
  assert.equal(detectImageMediaType(Buffer.from("not-an-image")), null);
});

test("compresses oversized images into a bounded vision-only JPEG", async () => {
  const width = 1200;
  const height = 1200;
  const png = await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
  assert.ok(png.byteLength > 1024 * 1024);
  const prepared = await prepareVisionImage({ bytes: png, mediaType: "image/png" }, 1024 * 1024);
  assert.equal(prepared.mediaType, "image/jpeg");
  assert.ok(prepared.bytes.byteLength <= 1024 * 1024);
});

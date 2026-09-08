import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { OneBotApiError, OneBotClient } from "../src/onebot-client.ts";

const config = loadConfig({
  ONEBOT_HTTP_URL: "http://127.0.0.1:3000",
  ONEBOT_WS_URL: "ws://127.0.0.1:3001",
  ONEBOT_ACCESS_TOKEN: "0123456789abcdef0123456789abcdef",
  ONEBOT_ALLOWED_QQ: "12345678",
});

test("sends proactive private messages with authorization", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 42 } }));
  };

  const client = new OneBotClient(config, fakeFetch);
  const result = await client.sendPrivateMessage("12345678", "主动消息测试");

  assert.equal(capturedUrl, "http://127.0.0.1:3000/send_private_msg");
  assert.equal(
    new Headers(capturedInit?.headers).get("authorization"),
    "Bearer 0123456789abcdef0123456789abcdef",
  );
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    user_id: 12345678,
    message: "主动消息测试",
    auto_escape: true,
  });
  assert.deepEqual(result, { message_id: 42 });
});

test("refuses to send to accounts outside the allowlist", async () => {
  const client = new OneBotClient(config, async () => {
    throw new Error("fetch must not be called");
  });
  await assert.rejects(client.sendPrivateMessage("87654321", "blocked"), /not present/u);
});

test("uploads a local file to the allowlisted private QQ", async () => {
  let body: Record<string, unknown> = {};
  const client = new OneBotClient(config, async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ status: "ok", retcode: 0, data: { file_id: "f1" } }));
  });
  const result = await client.sendPrivateFile("12345678", "D:\\work\\report.pdf", "report.pdf");
  assert.deepEqual(body, { user_id: 12345678, file: "D:\\work\\report.pdf", name: "report.pdf" });
  assert.deepEqual(result, { file_id: "f1" });
});

test("resolves a QQ image through the OneBot get_image API", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  const client = new OneBotClient(config, async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ status: "ok", retcode: 0, data: { file: "D:\\qq-cache\\image.png" } }));
  });
  assert.deepEqual(await client.getImage("qq-image-id"), { file: "D:\\qq-cache\\image.png" });
  assert.equal(url, "http://127.0.0.1:3000/get_image");
  assert.deepEqual(body, { file: "qq-image-id" });
});

test("sends a local image as a OneBot message segment", async () => {
  let body: Record<string, unknown> = {};
  const client = new OneBotClient(config, async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 43 } }));
  });
  await client.sendPrivateImage("12345678", "file:///D:/stickers/ok.gif");
  assert.deepEqual(body, {
    user_id: 12345678,
    message: [{ type: "image", data: { file: "file:///D:/stickers/ok.gif" } }],
  });
});

test("preserves QQ native custom sticker send metadata", async () => {
  let body: Record<string, unknown> = {};
  const client = new OneBotClient(config, async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 44 } }));
  });
  await client.sendPrivateImage("12345678", "file:///D:/stickers/native.png", { summary: "[动画表情]", subType: 1 });
  assert.deepEqual(body, {
    user_id: 12345678,
    message: [{ type: "image", data: { file: "file:///D:/stickers/native.png", summary: "[动画表情]", sub_type: 1 } }],
  });
});

test("surfaces OneBot API failures without exposing credentials", async () => {
  const client = new OneBotClient(
    config,
    async () =>
      new Response(JSON.stringify({ status: "failed", retcode: 1404, wording: "not logged in" }), {
        status: 200,
      }),
  );

  await assert.rejects(
    client.getStatus(),
    (error: unknown) =>
      error instanceof OneBotApiError && error.retcode === 1404 && !error.message.includes("012345"),
  );
});

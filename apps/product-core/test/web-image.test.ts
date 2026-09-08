import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { WebImageService } from "../src/web-image.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const publicResolver = async (): Promise<string[]> => ["93.184.216.34"];

test("resolves an og:image page and verifies the downloaded image bytes", async () => {
  const responses = [
    new Response('<html><head><meta property="og:image" content="/cover.png"></head></html>', { headers: { "content-type": "text/html" } }),
    new Response(PNG, { headers: { "content-type": "image/png", "content-length": String(PNG.length) } }),
  ];
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return responses.shift()!;
  }) as typeof fetch;
  const result = await new WebImageService(fetchImpl, publicResolver).resolve("https://example.com/post/1");
  assert.equal(result.imageUrl, "https://example.com/cover.png");
  assert.equal(result.mediaType, "image/png");
  assert.deepEqual(result.bytes, PNG);
  assert.deepEqual(requested, ["https://example.com/post/1", "https://example.com/cover.png"]);
});

test("rejects private network targets before fetching", async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return new Response(PNG); }) as typeof fetch;
  await assert.rejects(new WebImageService(fetchImpl).resolve("http://127.0.0.1/private.png"), /private|unsafe/u);
  assert.equal(called, false);
});

test("rejects HTML pages without a declared shareable image", async () => {
  const fetchImpl = (async () => new Response("<html><body>no image</body></html>", { headers: { "content-type": "text/html" } })) as typeof fetch;
  await assert.rejects(new WebImageService(fetchImpl, publicResolver).resolve("https://example.com/post/2"), /No shareable preview/u);
});

test("prefers the original WordPress image over a sized thumbnail URL", async () => {
  const thumbnail = await sharp({ create: { width: 129, height: 280, channels: 3, background: "white" } }).jpeg().toBuffer();
  const original = await sharp({ create: { width: 1290, height: 2800, channels: 3, background: "white" } }).jpeg().toBuffer();
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const bytes = url.endsWith("photo.jpg") ? original : thumbnail;
    return new Response(bytes, { headers: { "content-type": "image/jpeg", "content-length": String(bytes.length) } });
  }) as typeof fetch;
  const result = await new WebImageService(fetchImpl, publicResolver).resolve("https://i1.wp.com/example/photo-129x280.jpg");
  assert.equal(result.imageUrl, "https://i1.wp.com/example/photo.jpg");
  assert.equal(result.width, 1290);
  assert.equal(result.height, 2800);
  assert.deepEqual(requested, ["https://i1.wp.com/example/photo-129x280.jpg", "https://i1.wp.com/example/photo.jpg"]);
});

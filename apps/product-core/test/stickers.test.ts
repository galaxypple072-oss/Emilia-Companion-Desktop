import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProductStore } from "../src/store.ts";
import {
  extractStickerDirective,
  isStickerSendRequest,
  isStickerTeachingCaption,
  parseStickerOutboxBody,
  StickerLibrary,
  stickerOutboxBody,
} from "../src/stickers.ts";

test("recognizes explicit sticker teaching instead of saving arbitrary images", () => {
  assert.equal(isStickerTeachingCaption("这个表情表示无语，以后可以用"), true);
  assert.equal(isStickerTeachingCaption("我来教你用表情包"), true);
  assert.equal(isStickerTeachingCaption("看看这张照片里是什么"), false);
  assert.equal(isStickerSendRequest("把刚保存的表情发出来"), true);
  assert.equal(isStickerSendRequest("你觉得这个表情怎么样"), false);
});

test("extracts one private sticker directive from an ordinary reply", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  assert.deepEqual(extractStickerDirective(`真是的。\n[[sticker:${id}]]`), { text: "真是的。", stickerId: id });
  assert.equal(parseStickerOutboxBody(stickerOutboxBody(id)), id);
});

test("learns copied stickers and enforces a global cooldown", async () => {
  const root = await mkdtemp(join(tmpdir(), "companion-stickers-"));
  const source = join(root, "source.gif");
  await writeFile(source, Buffer.from("GIF89a"));
  const store = new ProductStore(":memory:");
  const library = new StickerLibrary(store, join(root, "library"));
  const sticker = await library.learn(source, "这个表示无语，以后可以用", "一只猫露出无语的表情", ".gif");
  assert.equal(Buffer.from(await readFile(sticker.path)).toString(), "GIF89a");
  assert.match(library.promptContext(), new RegExp(sticker.id, "u"));
  assert.equal(library.resolveUsable(sticker.id, 1_000)?.id, sticker.id);
  store.markStickerUsed(sticker.id, 1_000);
  assert.equal(library.resolveUsable(sticker.id, 1_000 + 9 * 60_000), null);
  assert.equal(library.resolveUsable(sticker.id, 1_000 + 11 * 60_000)?.id, sticker.id);
  assert.equal(store.findSticker("发一个无语表情")?.id, sticker.id);
  store.close();
});

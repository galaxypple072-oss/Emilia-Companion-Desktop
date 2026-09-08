import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ANIMATIONS } from "../src/state-machine.js";

const assetsRoot = new URL("../src/assets/", import.meta.url);

function readPngHeader(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer[25],
  };
}

for (const [state, definition] of Object.entries(ANIMATIONS)) {
  test(`${state} ships a complete lossless RGBA frame set`, async () => {
    const manifestUrl = new URL(`${state}/manifest.json`, assetsRoot);
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
    assert.equal(manifest.frameCount, definition.frameCount);
    assert.equal(manifest.delayMs, definition.delayMs);
    assert.equal(manifest.resized, false);
    assert.equal(manifest.alignment?.version, 1);
    assert.deepEqual(manifest.alignment?.target, { faceX: 211, groundY: 421 });
    assert.equal(manifest.alignment?.offsets.length, definition.frameCount);

    for (let frame = 0; frame < definition.frameCount; frame += 1) {
      const frameUrl = new URL(`${state}/frames/${String(frame).padStart(2, "0")}.png`, assetsRoot);
      const png = await readFile(frameUrl);
      const header = readPngHeader(png);
      assert.equal(header.width, manifest.frameWidth, fileURLToPath(frameUrl));
      assert.equal(header.height, manifest.frameHeight, fileURLToPath(frameUrl));
      assert.equal(header.colorType, 6, `${fileURLToPath(frameUrl)} must be RGBA`);
    }
  });
}

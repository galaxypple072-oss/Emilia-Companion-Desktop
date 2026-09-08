import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const wardrobeRoot = new URL("../src/assets/live2d/emilia/", import.meta.url);

function motionTotals(document) {
  let segments = 0;
  let points = 0;
  for (const curve of document.Curves ?? []) {
    if (curve.Segments.length < 2) continue;
    points += 1;
    for (let position = 2; position < curve.Segments.length;) {
      segments += 1;
      if (curve.Segments[position] === 1) {
        points += 3;
        position += 7;
      } else {
        points += 1;
        position += 3;
      }
    }
  }
  return { segments, points };
}

function pngDimensions(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("wardrobe ships ten optimized and complete Emilia Live2D outfits", async () => {
  const wardrobe = JSON.parse(await readFile(new URL("wardrobe.json", wardrobeRoot), "utf8"));
  assert.equal(wardrobe.version, 1);
  assert.equal(wardrobe.defaultOutfit, "sleepwear");
  assert.equal(wardrobe.outfits.length, 10);
  assert.equal(new Set(wardrobe.outfits.map((outfit) => outfit.id)).size, 10);

  for (const outfit of wardrobe.outfits) {
    const modelRoot = new URL(`${outfit.id}/`, wardrobeRoot);
    const model = JSON.parse(await readFile(new URL("model.model3.json", modelRoot), "utf8"));
    await access(new URL(model.FileReferences.Moc, modelRoot));
    assert.deepEqual(Object.keys(model.FileReferences.Motions), [
      "Idle", "Smile", "Surprise", "Think", "Angry", "Nod", "Shy", "Talk",
    ]);

    for (const texture of model.FileReferences.Textures) {
      const dimensions = pngDimensions(await readFile(new URL(texture, modelRoot)));
      assert.equal((dimensions.width & (dimensions.width - 1)), 0, `${outfit.id} texture width must be power-of-two`);
      assert.equal((dimensions.height & (dimensions.height - 1)), 0, `${outfit.id} texture height must be power-of-two`);
      assert.ok(dimensions.width <= 2048 && dimensions.height <= 2048);
    }

    const thumbnail = pngDimensions(await readFile(new URL("thumbnail.png", modelRoot)));
    assert.deepEqual(thumbnail, { width: 180, height: 228 });

    for (const motions of Object.values(model.FileReferences.Motions)) {
      assert.ok(motions.length > 0, `${outfit.id} has an empty motion group`);
      for (const reference of motions) {
        const motion = JSON.parse(await readFile(new URL(reference.File, modelRoot), "utf8"));
        const totals = motionTotals(motion);
        assert.equal(motion.Meta.CurveCount, motion.Curves.length);
        assert.equal(motion.Meta.TotalSegmentCount, totals.segments);
        assert.equal(motion.Meta.TotalPointCount, totals.points);
      }
    }
  }
});

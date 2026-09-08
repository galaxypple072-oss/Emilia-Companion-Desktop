import assert from "node:assert/strict";
import test from "node:test";
import { loadSavedOutfit, resolveOutfit, saveOutfit, validateWardrobe } from "../src/emilia-wardrobe.js";

const wardrobe = validateWardrobe({
  version: 1,
  defaultOutfit: "sleepwear",
  outfits: [
    { id: "classic", name: "经典服", shortName: "经典", model: "classic/model.json", thumbnail: "classic/thumb.png" },
    { id: "sleepwear", name: "粉色睡衣", shortName: "睡衣", model: "sleepwear/model.json", thumbnail: "sleepwear/thumb.png" },
  ],
});

function memoryStorage(value = null) {
  let stored = value;
  return {
    getItem: () => stored,
    setItem: (_key, next) => { stored = next; },
  };
}

test("wardrobe resolves unknown saved ids to the configured default", () => {
  assert.equal(resolveOutfit(wardrobe, "missing").id, "sleepwear");
  assert.equal(loadSavedOutfit(wardrobe, memoryStorage("missing")).id, "sleepwear");
});

test("wardrobe persists the selected outfit", () => {
  const storage = memoryStorage();
  saveOutfit("classic", storage);
  assert.equal(loadSavedOutfit(wardrobe, storage).id, "classic");
});

test("wardrobe rejects duplicate outfit ids", () => {
  assert.throws(() => validateWardrobe({
    version: 1,
    defaultOutfit: "same",
    outfits: [
      { id: "same", name: "A", shortName: "A", model: "a", thumbnail: "a" },
      { id: "same", name: "B", shortName: "B", model: "b", thumbnail: "b" },
    ],
  }), /重复/);
});

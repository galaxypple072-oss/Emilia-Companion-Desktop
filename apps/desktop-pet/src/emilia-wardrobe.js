export const OUTFIT_STORAGE_KEY = "emilia.outfit.v1";
export const WARDROBE_URL = "./assets/live2d/emilia/wardrobe.json";

let cachedWardrobe = null;

export function validateWardrobe(document) {
  if (!document || document.version !== 1 || !Array.isArray(document.outfits) || !document.outfits.length) {
    throw new Error("艾米莉亚衣柜清单格式错误");
  }
  const ids = new Set();
  const outfits = document.outfits.map((outfit) => {
    if (!outfit || typeof outfit.id !== "string" || !outfit.id || ids.has(outfit.id)) {
      throw new Error("艾米莉亚衣柜包含无效或重复的服装 ID");
    }
    for (const field of ["name", "shortName", "model", "thumbnail"]) {
      if (typeof outfit[field] !== "string" || !outfit[field]) throw new Error(`服装 ${outfit.id} 缺少 ${field}`);
    }
    ids.add(outfit.id);
    return Object.freeze({ ...outfit });
  });
  const defaultOutfit = ids.has(document.defaultOutfit) ? document.defaultOutfit : outfits[0].id;
  return Object.freeze({ version: 1, defaultOutfit, outfits: Object.freeze(outfits) });
}

export async function loadEmiliaWardrobe(fetchFn = fetch) {
  if (cachedWardrobe) return cachedWardrobe;
  const response = await fetchFn(WARDROBE_URL);
  if (!response.ok) throw new Error(`无法读取艾米莉亚衣柜：${response.status}`);
  cachedWardrobe = validateWardrobe(await response.json());
  return cachedWardrobe;
}

export function resolveOutfit(wardrobe, outfitId) {
  return wardrobe.outfits.find((outfit) => outfit.id === outfitId)
    ?? wardrobe.outfits.find((outfit) => outfit.id === wardrobe.defaultOutfit)
    ?? wardrobe.outfits[0];
}

export function loadSavedOutfit(wardrobe, storage = localStorage) {
  return resolveOutfit(wardrobe, storage.getItem(OUTFIT_STORAGE_KEY));
}

export function saveOutfit(outfitId, storage = localStorage) {
  storage.setItem(OUTFIT_STORAGE_KEY, outfitId);
}

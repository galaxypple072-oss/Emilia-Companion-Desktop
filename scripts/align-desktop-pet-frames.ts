import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

type Offset = Readonly<{ x: number; y: number }>;

const projectRoot = path.resolve(import.meta.dirname, "..");
const assetsRoot = path.join(projectRoot, "apps", "desktop-pet", "src", "assets");
const targetAnchor = Object.freeze({ faceX: 211, groundY: 421 });

const offsets: Readonly<Record<string, readonly Offset[]>> = Object.freeze({
  idle: [
    { x: 9, y: 0 }, { x: 12, y: 1 }, { x: 17, y: 0 }, { x: 20, y: 0 },
    { x: 12, y: 7 }, { x: 12, y: 8 }, { x: 16, y: 7 }, { x: 21, y: 7 },
  ],
  "walk-left": [
    { x: 49, y: 30 }, { x: 54, y: 27 }, { x: 56, y: 25 }, { x: 57, y: 29 },
    { x: 53, y: 29 }, { x: 54, y: 28 }, { x: 57, y: 29 }, { x: 58, y: 29 },
  ],
  "walk-right": [
    { x: -19, y: 15 }, { x: -12, y: 17 }, { x: -10, y: 12 }, { x: -8, y: 17 },
    { x: -17, y: 14 }, { x: -12, y: 13 }, { x: -9, y: 12 }, { x: -13, y: 14 },
  ],
  casting: [
    { x: 8, y: 31 }, { x: 7, y: 31 }, { x: 9, y: 31 }, { x: 10, y: 31 },
    { x: 8, y: 30 }, { x: 7, y: 30 }, { x: 9, y: 30 }, { x: 11, y: 30 },
  ],
});

function translateRgba(input: Buffer, width: number, height: number, offset: Offset) {
  const output = Buffer.alloc(input.length);
  const sourceX = Math.max(0, -offset.x);
  const destinationX = Math.max(0, offset.x);
  const sourceY = Math.max(0, -offset.y);
  const destinationY = Math.max(0, offset.y);
  const copyWidth = width - Math.abs(offset.x);
  const copyHeight = height - Math.abs(offset.y);

  if (copyWidth <= 0 || copyHeight <= 0) throw new Error(`Offset exceeds frame: ${JSON.stringify(offset)}`);
  for (let row = 0; row < copyHeight; row += 1) {
    const inputStart = ((sourceY + row) * width + sourceX) * 4;
    const outputStart = ((destinationY + row) * width + destinationX) * 4;
    input.copy(output, outputStart, inputStart, inputStart + copyWidth * 4);
  }
  return output;
}

for (const [state, stateOffsets] of Object.entries(offsets)) {
  const stateRoot = path.join(assetsRoot, state);
  const manifestPath = path.join(stateRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.alignment?.version === 1) continue;
  if (manifest.frameCount !== stateOffsets.length) throw new Error(`${state}: frame count mismatch`);

  for (let index = 0; index < stateOffsets.length; index += 1) {
    const framePath = path.join(stateRoot, "frames", `${String(index).padStart(2, "0")}.png`);
    const temporaryPath = `${framePath}.aligned.png`;
    const { data, info } = await sharp(framePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const translated = translateRgba(data, info.width, info.height, stateOffsets[index]);
    await sharp(translated, { raw: info }).png({ compressionLevel: 9 }).toFile(temporaryPath);
    await rename(temporaryPath, framePath);
  }

  manifest.alignment = {
    version: 1,
    method: "face-center-and-ground-anchor",
    target: targetAnchor,
    offsets: stateOffsets,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[pet-align] ${state}: ${stateOffsets.length} frames aligned`);
}

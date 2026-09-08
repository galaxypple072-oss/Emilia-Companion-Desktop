import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const sourceRoot = path.resolve(process.argv[2] || "");
if (!process.argv[2]) {
  throw new Error("用法：pnpm pet:prepare-live2d -- <Live2D Characters 目录>");
}

const outputRoot = path.resolve(
  import.meta.dirname,
  "../apps/desktop-pet/src/assets/live2d/emilia",
);

const outfits = [
  { id: "classic", source: "ac_base_emilia01", name: "经典服", shortName: "经典" },
  { id: "classic-alt", source: "ac_base_emilia02", name: "经典服·另一形态", shortName: "经典Ⅱ" },
  { id: "dress", source: "ac_base_emilia_dress01", name: "紫晶礼服", shortName: "礼服" },
  { id: "hood", source: "ac_base_emilia_hood01", name: "兜帽斗篷", shortName: "斗篷" },
  { id: "swimsuit", source: "ac_base_emilia_mizugi01", name: "夏日泳装", shortName: "泳装" },
  { id: "sleepwear", source: "ac_base_emilia_nemaki01", name: "粉色睡衣", shortName: "粉睡衣" },
  { id: "sleepwear-green", source: "ac_base_emilia_nemaki02", name: "薄荷睡衣", shortName: "薄荷" },
  { id: "sleepwear-robe", source: "ac_base_emilia_nemaki03", name: "紫色睡袍", shortName: "睡袍" },
  { id: "wedding", source: "ac_base_emilia_wedding01", name: "纯白婚纱", shortName: "婚纱" },
  { id: "christmas", source: "ac_base_emilia_xmas01", name: "圣诞礼装", shortName: "圣诞" },
] as const;

const motionGroups = {
  Idle: ["__default", "_select_idle", "_select_idle02", "_act_normal_w"],
  Smile: ["_act_egao", "_act_hohoemu", "_act_hohoemu03"],
  Surprise: ["_act_bikkuri", "_act_bikkuri02", "_act_odoroku"],
  Think: ["_act_kangaeru", "_act_nayamu"],
  Angry: ["_act_ikaru", "_act_punpun"],
  Nod: ["_act_unazuku", "_act_unazuku02"],
  Shy: ["_act_uru", "_act_suneru"],
  Talk: ["_face_talk_small", "_face_talk_normal", "_face_talk_large"],
} as const;

function nextPowerOfTwo(value: number) {
  return 2 ** Math.ceil(Math.log2(value));
}

function repairMotionMetadata(document: any) {
  let totalSegmentCount = 0;
  let totalPointCount = 0;
  for (const curve of document.Curves ?? []) {
    const segments = curve.Segments ?? [];
    if (segments.length < 2) continue;
    totalPointCount += 1;
    for (let position = 2; position < segments.length;) {
      totalSegmentCount += 1;
      if (segments[position] === 1) {
        totalPointCount += 3;
        position += 7;
      } else {
        totalPointCount += 1;
        position += 3;
      }
    }
  }
  document.Meta.CurveCount = document.Curves?.length ?? 0;
  document.Meta.TotalSegmentCount = totalSegmentCount;
  document.Meta.TotalPointCount = totalPointCount;
  document.Meta.UserDataCount = document.UserData?.length ?? 0;
  document.Meta.TotalUserDataSize = (document.UserData ?? [])
    .reduce((total: number, event: any) => total + String(event.Value ?? "").length, 0);
  return document;
}

async function prepareOutfit(outfit: (typeof outfits)[number]) {
  const sourceDirectory = path.join(sourceRoot, outfit.source);
  const destinationDirectory = path.join(outputRoot, outfit.id);
  const sourceModel = JSON.parse(await readFile(
    path.join(sourceDirectory, `${outfit.source}.model3.json`),
    "utf8",
  ));
  await mkdir(path.join(destinationDirectory, "textures"), { recursive: true });
  await mkdir(path.join(destinationDirectory, "motions"), { recursive: true });
  await copyFile(
    path.join(sourceDirectory, `${outfit.source}.moc3`),
    path.join(destinationDirectory, "model.moc3"),
  );

  const textures: string[] = [];
  for (let index = 0; index < sourceModel.FileReferences.Textures.length; index += 1) {
    const relative = sourceModel.FileReferences.Textures[index];
    const sourceTexture = path.join(sourceDirectory, relative);
    const metadata = await sharp(sourceTexture).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`无法读取纹理尺寸：${sourceTexture}`);
    const width = nextPowerOfTwo(metadata.width);
    const height = nextPowerOfTwo(metadata.height);
    const output = `textures/texture_${String(index).padStart(2, "0")}.png`;
    const pipeline = sharp(sourceTexture);
    if (width !== metadata.width || height !== metadata.height) {
      pipeline.resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 });
    }
    await pipeline.png().toFile(path.join(destinationDirectory, output));
    textures.push(output);
  }

  const sourceMotionDirectory = path.join(sourceDirectory, "motions");
  const sourceMotionFiles = await readdir(sourceMotionDirectory);
  const motions: Record<string, Array<{ File: string }>> = {};
  for (const [group, suffixes] of Object.entries(motionGroups)) {
    const selected = suffixes
      .map((suffix) => sourceMotionFiles.find((file) => file.endsWith(`${suffix}.motion3.json`)))
      .filter((file): file is string => Boolean(file));
    if (!selected.length) throw new Error(`${outfit.id} 缺少 ${group} 动作`);
    motions[group] = [];
    for (let index = 0; index < selected.length; index += 1) {
      const output = `motions/${group.toLowerCase()}-${index}.motion3.json`;
      const document = repairMotionMetadata(JSON.parse(await readFile(
        path.join(sourceMotionDirectory, selected[index]),
        "utf8",
      )));
      await writeFile(path.join(destinationDirectory, output), `${JSON.stringify(document)}\n`);
      motions[group].push({ File: output });
    }
  }

  sourceModel.FileReferences = {
    Moc: "model.moc3",
    Textures: textures,
    Motions: motions,
  };
  sourceModel.Groups = [
    { Target: "Parameter", Name: "EyeBlink", Ids: ["ParamEyeLOpen", "ParamEyeROpen"] },
    { Target: "Parameter", Name: "LipSync", Ids: ["ParamMouthOpenY"] },
  ];
  await writeFile(
    path.join(destinationDirectory, "model.model3.json"),
    `${JSON.stringify(sourceModel, null, 2)}\n`,
  );
  return {
    ...outfit,
    model: `./assets/live2d/emilia/${outfit.id}/model.model3.json`,
    thumbnail: `./assets/live2d/emilia/${outfit.id}/thumbnail.png`,
    textureCount: textures.length,
    motionCount: Object.values(motions).reduce((total, group) => total + group.length, 0),
  };
}

await mkdir(outputRoot, { recursive: true });
const manifest = [];
for (const outfit of outfits) manifest.push(await prepareOutfit(outfit));
await writeFile(
  path.join(outputRoot, "wardrobe.json"),
  `${JSON.stringify({ version: 1, defaultOutfit: "sleepwear", outfits: manifest }, null, 2)}\n`,
);
console.log(`[live2d] 已整理 ${manifest.length} 套艾米莉亚服装到 ${outputRoot}`);

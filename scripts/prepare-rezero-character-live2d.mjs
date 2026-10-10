import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const sourceRoot = path.resolve(process.argv[2] || "");
if (!process.argv[2]) {
  throw new Error("用法：node scripts/prepare-rezero-character-live2d.mjs <Live2D Characters 目录>");
}

const outputRoot = path.resolve("apps/desktop-pet/src/assets/live2d/characters");
const characters = [
  { id: "rem", source: "ac_base_rem01", name: "雷姆" },
  { id: "ram", source: "ac_base_ram01", name: "拉姆" },
  { id: "beatrice", source: "ac_base_beatrice01", name: "贝蒂" },
  { id: "felt", source: "ac_base_felt01", name: "菲鲁特" },
  { id: "crusch", source: "ac_base_crusch01", name: "库珥修" },
  { id: "anastasia", source: "ac_base_anastasia01", name: "安娜塔西亚" },
  { id: "echidna", source: "ac_base_echidna01", name: "爱姬多娜" },
];

const motionGroups = {
  Idle: ["_act_normal_w", "_act_tameiki", "_act_tameiki02"],
  Smile: ["_act_egao", "_act_hohoemu", "_act_egao02"],
  Surprise: ["_act_bikkuri", "_act_odoroku", "_act_sakebu"],
  Think: ["_act_kangaeru", "_act_nayamu"],
  Angry: ["_act_ikaru", "_act_punpun", "_act_gununu"],
  Nod: ["_act_unazuku", "_act_unazuku02", "_act_yubisashi"],
  Shy: ["_act_uru", "_act_suneru", "_act_tereru"],
  Talk: ["_face_talk_small", "_face_talk_normal", "_face_talk_large"],
};

function repairMotionMetadata(document) {
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
  if (document.Meta) {
    document.Meta.CurveCount = document.Curves?.length ?? 0;
    document.Meta.TotalSegmentCount = totalSegmentCount;
    document.Meta.TotalPointCount = totalPointCount;
    document.Meta.UserDataCount = document.UserData?.length ?? 0;
    document.Meta.TotalUserDataSize = (document.UserData ?? [])
      .reduce((total, event) => total + String(event.Value ?? "").length, 0);
  }
  return document;
}

function referencedFiles(model) {
  const refs = model.FileReferences ?? {};
  const files = new Set();
  if (refs.Moc) files.add(refs.Moc);
  for (const texture of refs.Textures ?? []) files.add(texture);
  for (const expression of refs.Expressions ?? []) if (expression.File) files.add(expression.File);
  for (const group of Object.values(refs.Motions ?? {})) {
    for (const motion of group ?? []) if (motion.File) files.add(motion.File);
  }
  for (const key of ["Physics", "Pose", "UserData"]) if (refs[key]) files.add(refs[key]);
  return [...files];
}

async function prepareCharacter(character) {
  const sourceDirectory = path.join(sourceRoot, character.source);
  const sourceModelPath = path.join(sourceDirectory, `${character.source}.model3.json`);
  const model = JSON.parse(await readFile(sourceModelPath, "utf8"));
  const sourceMotions = await readdir(path.join(sourceDirectory, "motions"));
  const destinationDirectory = path.join(outputRoot, character.id, "classic");
  await mkdir(destinationDirectory, { recursive: true });

  const references = model.FileReferences;
  const sourceReferencePaths = referencedFiles(model);
  const oldMoc = references.Moc;
  const oldTextures = [...(references.Textures ?? [])];
  const texturePathMap = new Map(oldTextures.map((file, index) => [
    file,
    `textures/texture_${String(index).padStart(2, "0")}.png`,
  ]));
  const allMotionEntries = Object.values(references.Motions ?? {}).flat();

  references.Moc = "model.moc3";
  references.Textures = oldTextures.map((file) => texturePathMap.get(file));
  references.Motions = { ...(references.Motions ?? {}) };
  const originalMotions = allMotionEntries.map((entry) => ({ ...entry }));
  references.Motions[""] = originalMotions;

  for (const [group, suffixes] of Object.entries(motionGroups)) {
    const selected = suffixes
      .map((suffix) => sourceMotions.find((file) => file.endsWith(`${suffix}.motion3.json`)))
      .filter(Boolean);
    if (!selected.length && group === "Idle") {
      const fallback = sourceMotions.find((file) => file.includes("_act_"));
      if (fallback) selected.push(fallback);
    }
    if (!selected.length) continue;
    references.Motions[group] = selected.map((file) => ({ File: `motions/${file}` }));
  }

  const oldToNew = new Map([[oldMoc, "model.moc3"], ...texturePathMap]);
  let copiedMotions = 0;
  for (const oldPath of sourceReferencePaths) {
    const relative = oldToNew.get(oldPath) ?? oldPath;
    const sourceFile = path.resolve(sourceDirectory, oldPath);
    const targetFile = path.resolve(destinationDirectory, relative);
    if (!sourceFile.startsWith(`${sourceDirectory}${path.sep}`)) {
      throw new Error(`模型引用越界：${character.id}/${oldPath}`);
    }
    if (targetFile !== destinationDirectory && !targetFile.startsWith(`${destinationDirectory}${path.sep}`)) {
      throw new Error(`输出引用越界：${character.id}/${relative}`);
    }
    const bytes = await readFile(sourceFile);
    await mkdir(path.dirname(targetFile), { recursive: true });
    if (oldPath.endsWith(".motion3.json")) {
      const motion = repairMotionMetadata(JSON.parse(bytes.toString("utf8")));
      await writeFile(targetFile, `${JSON.stringify(motion)}\n`);
      copiedMotions += 1;
    } else {
      await copyFile(sourceFile, targetFile);
    }
  }

  const modelPath = path.join(destinationDirectory, "model.model3.json");
  await writeFile(modelPath, `${JSON.stringify(model, null, 2)}\n`);
  const check = JSON.parse(await readFile(modelPath, "utf8"));
  for (const file of referencedFiles(check)) {
    await readFile(path.resolve(destinationDirectory, file));
  }

  return {
    id: character.id,
    name: character.name,
    outfit: "classic",
    model: `./assets/live2d/characters/${character.id}/classic/model.model3.json`,
    motionGroups: Object.fromEntries(Object.entries(check.FileReferences.Motions)
      .filter(([group]) => group)
      .map(([group, entries]) => [group, entries.length])),
    textureCount: check.FileReferences.Textures.length,
    motionCount: originalMotions.length,
    copiedMotionFiles: copiedMotions,
  };
}

await mkdir(outputRoot, { recursive: true });
const manifest = [];
for (const character of characters) manifest.push(await prepareCharacter(character));
await writeFile(
  path.join(outputRoot, "characters.json"),
  `${JSON.stringify({ version: 1, characters: manifest }, null, 2)}\n`,
);
console.log(`[live2d] 已整理 ${manifest.length} 个角色到 ${outputRoot}`);
for (const character of manifest) {
  console.log(`- ${character.name}: ${character.motionCount} 个原始动作，${character.copiedMotionFiles} 个动作文件`);
}

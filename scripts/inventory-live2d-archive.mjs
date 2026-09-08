import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const sourceRoot = path.resolve(process.argv[2] || "");
const outputRoot = path.resolve(process.argv[3] || "docs/live2d");
if (!process.argv[2]) throw new Error("Usage: node scripts/inventory-live2d-archive.mjs <model-root> [output-root]");

async function listFiles(root, prefix = "") {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function referencedFiles(model) {
  const refs = model.FileReferences || {};
  const files = [refs.Moc, refs.Physics, refs.Pose, ...(refs.Textures || [])];
  for (const expression of refs.Expressions || []) files.push(expression?.File);
  for (const motions of Object.values(refs.Motions || {})) {
    for (const motion of motions || []) files.push(motion?.File, motion?.Sound);
  }
  return files.filter((value) => typeof value === "string" && value.length > 0);
}

const modelDirectories = (await readdir(sourceRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const models = [];
for (const id of modelDirectories) {
  const directory = path.join(sourceRoot, id);
  const files = await listFiles(directory);
  const modelFile = files.find((file) => file.endsWith(".model3.json") && !file.endsWith(".preview.model3.json"));
  const mocFile = files.find((file) => file.endsWith(".moc3"));
  const document = modelFile ? JSON.parse(await readFile(path.join(directory, modelFile), "utf8")) : {};
  const missingReferences = referencedFiles(document).filter((file) => !files.includes(file));
  let totalBytes = 0;
  for (const file of files.filter((item) => !item.includes(".preview-") && !item.endsWith(".preview.model3.json"))) {
    totalBytes += (await stat(path.join(directory, file))).size;
  }
  models.push({
    id,
    modelFile: modelFile || null,
    mocFile: mocFile || null,
    textures: files.filter((file) => /(^|\/)textures\/.*\.png$/i.test(file) && !file.includes(".preview-2048.")).length,
    motions: files.filter((file) => file.endsWith(".motion3.json")).length,
    expressions: files.filter((file) => file.endsWith(".exp3.json")).length,
    totalBytes,
    missingReferences,
  });
}

const summary = {
  models: models.length,
  textures: models.reduce((sum, model) => sum + model.textures, 0),
  motions: models.reduce((sum, model) => sum + model.motions, 0),
  expressions: models.reduce((sum, model) => sum + model.expressions, 0),
  bytes: models.reduce((sum, model) => sum + model.totalBytes, 0),
  modelsWithMissingReferences: models.filter((model) => model.missingReferences.length > 0).length,
};

const mebibytes = (bytes) => (bytes / 1024 / 1024).toFixed(2);
const markdown = [
  "# Re:Zero Lost in Memories Live2D archive inventory",
  "",
  `- Models: ${summary.models}`,
  `- Textures: ${summary.textures}`,
  `- Motion files: ${summary.motions}`,
  `- Expression files: ${summary.expressions}`,
  `- Original extracted size: ${mebibytes(summary.bytes)} MiB`,
  `- Models with missing referenced files: ${summary.modelsWithMissingReferences}`,
  "",
  "| Model ID | Motions | Expressions | Textures | Size (MiB) | Missing refs |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
  ...models.map((model) => `| ${model.id} | ${model.motions} | ${model.expressions} | ${model.textures} | ${mebibytes(model.totalBytes)} | ${model.missingReferences.length} |`),
  "",
].join("\n");

await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, "archive-inventory.json"), `${JSON.stringify({ summary, models }, null, 2)}\n`);
await writeFile(path.join(outputRoot, "archive-inventory.md"), markdown);
console.log(JSON.stringify(summary, null, 2));

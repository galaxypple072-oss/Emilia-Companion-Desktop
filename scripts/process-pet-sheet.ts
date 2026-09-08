import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import sharp from "sharp";

interface Options {
  input: string;
  output: string;
  columns: number;
  rows: number;
  inset: number;
  delay: number;
  rowOffsetsY: number[];
}

function parsePositiveInteger(value: string | undefined, label: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key ?? "end"}`);
    values.set(key.slice(2), value);
  }
  const input = values.get("input");
  const output = values.get("output");
  if (!input || !output) {
    throw new Error("Usage: --input <sheet.png> --output <directory> [--columns 4 --rows 2 --inset 3 --delay 180 --row-offsets-y 0,0]");
  }
  const rows = parsePositiveInteger(values.get("rows"), "rows", 2);
  const rowOffsetsY = (values.get("row-offsets-y") ?? Array(rows).fill("0").join(","))
    .split(",")
    .map((value) => Number(value.trim()));
  if (rowOffsetsY.length !== rows || rowOffsetsY.some((value) => !Number.isInteger(value))) {
    throw new Error(`row-offsets-y must contain exactly ${rows} comma-separated integers`);
  }
  return {
    input: resolve(input),
    output: resolve(output),
    columns: parsePositiveInteger(values.get("columns"), "columns", 4),
    rows,
    inset: parsePositiveInteger(values.get("inset"), "inset", 3),
    delay: parsePositiveInteger(values.get("delay"), "delay", 180),
    rowOffsetsY,
  };
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 0;
}

function backgroundColor(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
): [number, number, number] {
  const samples: [number[], number[], number[]] = [[], [], []];
  const patch = Math.min(18, Math.floor(Math.min(width, height) / 8));
  const corners = [[0, 0], [width - patch, 0], [0, height - patch], [width - patch, height - patch]];
  for (const [startX, startY] of corners) {
    for (let y = startY; y < startY + patch; y += 1) {
      for (let x = startX; x < startX + patch; x += 1) {
        const offset = (y * width + x) * channels;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        if (red > 150 && red > green * 2 && red > blue * 2) {
          samples[0].push(red);
          samples[1].push(green);
          samples[2].push(blue);
        }
      }
    }
  }
  if (samples[0].length < 32) throw new Error("Could not sample the chroma background from frame corners");
  return [median(samples[0]), median(samples[1]), median(samples[2])];
}

function smoothstep(value: number): number {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded * bounded * (3 - 2 * bounded);
}

function removeChroma(
  source: Buffer,
  width: number,
  height: number,
  channels: number,
): { rgba: Buffer; background: [number, number, number]; partialAlphaPixels: number } {
  const background = backgroundColor(source, width, height, channels);
  const rgba = Buffer.alloc(width * height * 4);
  let partialAlphaPixels = 0;
  const backgroundDominance = background[0] - Math.max(background[1], background[2]);
  const neutralDominance = 28;

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const sourceOffset = pixel * channels;
    const outputOffset = pixel * 4;
    const red = source[sourceOffset];
    const green = source[sourceOffset + 1];
    const blue = source[sourceOffset + 2];
    const redDominance = red - Math.max(green, blue);
    const chromaAmount = (redDominance - neutralDominance) / (backgroundDominance - neutralDominance);
    const alphaUnit = smoothstep(1 - chromaAmount);
    let alpha = Math.round(alphaUnit * 255);
    if (alpha < 20) alpha = 0;
    if (alpha > 247) alpha = 255;

    if (alpha === 0) {
      rgba[outputOffset] = 0;
      rgba[outputOffset + 1] = 0;
      rgba[outputOffset + 2] = 0;
      rgba[outputOffset + 3] = 0;
      continue;
    }
    if (alpha !== 255) partialAlphaPixels += 1;
    const opacity = alpha / 255;
    rgba[outputOffset] = Math.max(0, Math.min(255, Math.round((red - background[0] * (1 - opacity)) / opacity)));
    rgba[outputOffset + 1] = Math.max(0, Math.min(255, Math.round((green - background[1] * (1 - opacity)) / opacity)));
    rgba[outputOffset + 2] = Math.max(0, Math.min(255, Math.round((blue - background[2] * (1 - opacity)) / opacity)));
    rgba[outputOffset + 3] = alpha;
  }
  const clearBorder = 5;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= clearBorder && x < width - clearBorder && y >= clearBorder && y < height - clearBorder) continue;
      const offset = (y * width + x) * 4;
      rgba[offset] = 0;
      rgba[offset + 1] = 0;
      rgba[offset + 2] = 0;
      rgba[offset + 3] = 0;
    }
  }
  return { rgba, background, partialAlphaPixels };
}

function translateRgba(source: Buffer, width: number, height: number, offsetY: number): Buffer {
  if (offsetY === 0) return source;
  const output = Buffer.alloc(source.length);
  for (let sourceY = 0; sourceY < height; sourceY += 1) {
    const targetY = sourceY + offsetY;
    if (targetY < 0 || targetY >= height) continue;
    source.copy(output, targetY * width * 4, sourceY * width * 4, (sourceY + 1) * width * 4);
  }
  return output;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const image = sharp(options.input);
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error("Input image dimensions are unavailable");
  const { data, info } = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const boundariesX = Array.from({ length: options.columns + 1 }, (_, index) => Math.round(index * info.width / options.columns));
  const boundariesY = Array.from({ length: options.rows + 1 }, (_, index) => Math.round(index * info.height / options.rows));
  const minimumCellWidth = Math.min(...boundariesX.slice(1).map((edge, index) => edge - boundariesX[index]));
  const minimumCellHeight = Math.min(...boundariesY.slice(1).map((edge, index) => edge - boundariesY[index]));
  const frameWidth = minimumCellWidth - options.inset * 2;
  const frameHeight = minimumCellHeight - options.inset * 2;
  if (frameWidth <= 0 || frameHeight <= 0) throw new Error("Inset is too large for the detected grid");

  const framesDirectory = join(options.output, "frames");
  await mkdir(framesDirectory, { recursive: true });
  const frameBuffers: Buffer[] = [];
  const reports: Array<Record<string, unknown>> = [];
  for (let row = 0; row < options.rows; row += 1) {
    for (let column = 0; column < options.columns; column += 1) {
      const left = boundariesX[column] + options.inset;
      const top = boundariesY[row] + options.inset;
      const { data: frameData, info: frameInfo } = await sharp(data, {
        raw: { width: info.width, height: info.height, channels: info.channels },
      }).extract({ left, top, width: frameWidth, height: frameHeight }).raw().toBuffer({ resolveWithObject: true });
      const result = removeChroma(frameData, frameInfo.width, frameInfo.height, frameInfo.channels);
      const offsetY = options.rowOffsetsY[row];
      const alignedRgba = translateRgba(result.rgba, frameWidth, frameHeight, offsetY);
      const png = await sharp(alignedRgba, {
        raw: { width: frameWidth, height: frameHeight, channels: 4 },
      }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
      const index = row * options.columns + column;
      await writeFile(join(framesDirectory, `${String(index).padStart(2, "0")}.png`), png);
      frameBuffers.push(alignedRgba);
      reports.push({ index, row, column, offsetY, background: result.background, partialAlphaPixels: result.partialAlphaPixels });
    }
  }

  const sheet = sharp({
    create: {
      width: frameWidth * options.columns,
      height: frameHeight * options.rows,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
  await sheet.composite(frameBuffers.map((input, index) => ({
    input,
    raw: { width: frameWidth, height: frameHeight, channels: 4 },
    left: (index % options.columns) * frameWidth,
    top: Math.floor(index / options.columns) * frameHeight,
  }))).png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(join(options.output, "spritesheet.png"));

  const stacked = Buffer.concat(frameBuffers);
  await sharp(stacked, {
    raw: {
      width: frameWidth,
      height: frameHeight * frameBuffers.length,
      channels: 4,
      pageHeight: frameHeight,
    },
  }).webp({ lossless: true, loop: 0, delay: Array(frameBuffers.length).fill(options.delay), effort: 6 })
    .toFile(join(options.output, "preview.webp"));

  const manifest = {
    source: basename(options.input),
    columns: options.columns,
    rows: options.rows,
    frameCount: frameBuffers.length,
    frameWidth,
    frameHeight,
    delayMs: options.delay,
    rowOffsetsY: options.rowOffsetsY,
    loop: true,
    alpha: "unassociated RGBA",
    resized: false,
    frames: reports,
  };
  await writeFile(join(options.output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output: options.output, ...manifest }, null, 2));
}

await main();

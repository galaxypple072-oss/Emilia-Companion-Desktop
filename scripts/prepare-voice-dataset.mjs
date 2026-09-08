#!/usr/bin/env node

/**
 * Build a review manifest for a locally licensed voice source.
 *
 * Usage:
 *   node scripts/prepare-voice-dataset.mjs [source-dir] [output-dir]
 *
 * The script never copies audio or uploads it. It only writes JSON/CSV metadata
 * beside the private assets so the audio stays out of git and out of the relay.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const sourceDir = resolve(
  process.argv[2] ?? join(projectRoot, 'private-assets/voice-source/Emilia'),
);
const outputDir = resolve(
  process.argv[3] ?? join(projectRoot, 'private-assets/voice-dataset'),
);

const gameplayMarkers = /\b(?:dmg|hp\d*|atk|buff|cutin|lose|vo_start|sp\d+|win)\b/i;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return walk(entryPath);
    return entry.isFile() && extname(entry.name).toLowerCase() === '.wav' ? [entryPath] : [];
  }));
  return nested.flat();
}

function readWavInfo(buffer) {
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WAVE') {
    return null;
  }

  let offset = 12;
  let channels;
  let sampleRate;
  let byteRate;
  let dataBytes;

  while (offset + 8 <= buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString('ascii');
    const size = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + size > buffer.length) break;

    if (id === 'fmt ' && size >= 16) {
      channels = buffer.readUInt16LE(dataOffset + 2);
      sampleRate = buffer.readUInt32LE(dataOffset + 4);
      byteRate = buffer.readUInt32LE(dataOffset + 8);
    }
    if (id === 'data') dataBytes = size;
    offset = dataOffset + size + (size % 2);
  }

  if (!byteRate || !dataBytes) return null;
  return {
    channels,
    sampleRate,
    byteRate,
    durationSeconds: Number((dataBytes / byteRate).toFixed(3)),
  };
}

function classify(category, filename, info) {
  if (!info) return { status: 'reject', reason: 'invalid_wav' };
  if (category === 'Sound Effects') return { status: 'reject', reason: 'sound_effect' };
  if (info.durationSeconds < 1.2) return { status: 'reject', reason: 'too_short' };
  if (gameplayMarkers.test(filename)) return { status: 'reject', reason: 'gameplay_reaction' };
  if (info.durationSeconds > 16) return { status: 'review', reason: 'long_clip' };
  if (category === 'Home' || category === 'Story') return { status: 'candidate', reason: 'clean_dialogue_candidate' };
  return { status: 'review', reason: 'unknown_context' };
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

const files = await walk(sourceDir);
const manifest = [];

for (const file of files.sort()) {
  const rel = relative(sourceDir, file);
  const [category = 'Unknown'] = rel.split('/');
  const [buffer, fileStats] = await Promise.all([readFile(file), stat(file)]);
  const info = readWavInfo(buffer);
  const classification = classify(category, rel, info);
  manifest.push({
    relativePath: rel,
    category,
    bytes: fileStats.size,
    ...info,
    ...classification,
    transcript: '',
    emotion: '',
    notes: '',
  });
}

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const reviewRows = [
  ['relative_path', 'category', 'duration_seconds', 'status', 'reason', 'transcript', 'emotion', 'notes'],
  ...manifest
    .filter((item) => item.status !== 'reject')
    .map((item) => [
      item.relativePath,
      item.category,
      item.durationSeconds ?? '',
      item.status,
      item.reason,
      '',
      '',
      '',
    ]),
];
await writeFile(
  join(outputDir, 'review.csv'),
  `${reviewRows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`,
);

const summary = manifest.reduce((result, item) => {
  result[item.status] = (result[item.status] ?? 0) + 1;
  if (item.status === 'candidate') result.candidateSeconds += item.durationSeconds ?? 0;
  return result;
}, { candidate: 0, review: 0, reject: 0, candidateSeconds: 0 });

console.log(JSON.stringify({ sourceDir, outputDir, files: manifest.length, ...summary }, null, 2));

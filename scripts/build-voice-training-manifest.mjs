#!/usr/bin/env node

/**
 * Merge manual review decisions with filename-level character isolation.
 * Only a solo Emilia filename is eligible for automatic inclusion:
 *   vo_sim_emiliaNNN#...     -> solo candidate
 *   vo_sim_emiliaremNNN#...  -> excluded as a multi-character variant
 *
 * Usage:
 *   node scripts/build-voice-training-manifest.mjs [review.csv] [manifest.json] [output.jsonl]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const reviewPath = resolve(process.argv[2] ?? '/Users/roseliayukina/Downloads/emilia-voice-review.csv');
const sourceManifestPath = resolve(process.argv[3] ?? join(projectRoot, 'private-assets/voice-dataset/manifest.json'));
const outputPath = resolve(process.argv[4] ?? join(projectRoot, 'private-assets/voice-dataset/training-manifest.jsonl'));

function parseCsvRow(line) {
  return [...line.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)]
    .map((match) => (match[1] ?? match[2]).replaceAll('""', '"'));
}

const csvRows = (await readFile(reviewPath, 'utf8')).trim().split(/\r?\n/).map(parseCsvRow);
const [header, ...csvData] = csvRows;
const reviewed = new Map(csvData.map((row) => {
  const record = Object.fromEntries(header.map((key, index) => [key, row[index] ?? '']));
  return [record.relative_path, record];
}));
const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'));

const isSoloEmiliaFilename = (path) => /(?:^|\/)vo_sim_emilia\d{3}#\d+ \(/i.test(path);
const excluded = [];
const trainingItems = [];

for (const item of sourceManifest) {
  if (item.status !== 'candidate' || item.category !== 'Home') continue;
  const manual = reviewed.get(item.relativePath);
  if (manual?.decision === 'reject') {
    excluded.push({ relativePath: item.relativePath, reason: 'manual_reject' });
    continue;
  }
  if (!isSoloEmiliaFilename(item.relativePath)) {
    excluded.push({ relativePath: item.relativePath, reason: 'non_solo_character_filename' });
    continue;
  }
  trainingItems.push({
    sourcePath: item.relativePath,
    durationSeconds: item.durationSeconds,
    sampleRate: item.sampleRate,
    channels: item.channels,
    selection: manual?.decision === 'accept' ? 'human_approved' : 'auto_solo_candidate',
    emotion: manual?.emotion ?? '',
    transcript: manual?.notes ?? '',
    transcriptStatus: manual?.notes ? 'manual' : 'pending_windows_asr',
  });
}

await writeFile(outputPath, `${trainingItems.map((item) => JSON.stringify(item)).join('\n')}\n`);
const exclusionPath = join(dirname(outputPath), 'training-exclusions.json');
await writeFile(exclusionPath, `${JSON.stringify(excluded, null, 2)}\n`);

const summary = trainingItems.reduce((result, item) => {
  result[item.selection] = (result[item.selection] ?? 0) + 1;
  result.seconds += item.durationSeconds;
  return result;
}, { human_approved: 0, auto_solo_candidate: 0, seconds: 0 });
console.log(JSON.stringify({ reviewPath, outputPath, exclusions: excluded.length, clips: trainingItems.length, ...summary }, null, 2));

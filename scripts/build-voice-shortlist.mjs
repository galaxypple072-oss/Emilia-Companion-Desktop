#!/usr/bin/env node

/**
 * Builds a compact, diverse audition pack from the automatically shortlisted
 * dialogue. It is an audition/quality-control sample, not the final train set.
 *
 * Usage:
 *   node scripts/build-voice-shortlist.mjs [manifest-path] [output-path]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const manifestPath = resolve(process.argv[2] ?? join(projectRoot, 'private-assets/voice-dataset/manifest.json'));
const outputPath = resolve(process.argv[3] ?? join(dirname(manifestPath), 'golden-shortlist.json'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

function characterVersion(item) {
  return item.relativePath.match(/vo_sim_emilia(?:rem)?\d+/i)?.[0] ?? item.relativePath;
}

function score(item) {
  const name = item.relativePath.toLowerCase();
  const targetDurationScore = Math.max(0, 20 - Math.abs(6.5 - item.durationSeconds) * 3);
  let contextScore = 0;
  if (/home_nrm\d+/.test(name)) contextScore += 18;
  else if (/home_(morning|noon|night)_nrm/.test(name)) contextScore += 15;
  else if (/home_(likeup|growup)/.test(name)) contextScore += 8;
  else if (/home_(birthday|christmas|newyear|valentine|halloween)/.test(name)) contextScore += 5;
  else if (/gacha|train|ignore/.test(name)) contextScore -= 18;
  return targetDurationScore + contextScore;
}

const candidates = manifest
  .filter((item) => item.status === 'candidate' && item.category === 'Home')
  .filter((item) => item.durationSeconds >= 2.5 && item.durationSeconds <= 12);
const groups = candidates.reduce((result, item) => {
  const key = characterVersion(item);
  if (!result.has(key)) result.set(key, []);
  result.get(key).push(item);
  return result;
}, new Map());
const shortlist = [...groups.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .flatMap(([, items]) => items
    .sort((left, right) => score(right) - score(left) || left.relativePath.localeCompare(right.relativePath))
    .slice(0, 3))
  .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  .map((item) => ({ ...item, shortlistReason: 'three diverse, medium-length home-dialogue samples per character version' }));

await writeFile(outputPath, `${JSON.stringify(shortlist, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, clips: shortlist.length, seconds: shortlist.reduce((total, item) => total + item.durationSeconds, 0) }, null, 2));

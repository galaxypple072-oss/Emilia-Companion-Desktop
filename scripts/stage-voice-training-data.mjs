#!/usr/bin/env node

/**
 * Materialize the approved/auto-solo training manifest into a self-contained
 * local staging directory for a Windows training machine.
 *
 * Usage:
 *   node scripts/stage-voice-training-data.mjs [training-manifest.jsonl] [stage-dir]
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const manifestPath = resolve(process.argv[2] ?? join(projectRoot, 'private-assets/voice-dataset/training-manifest.jsonl'));
const stageDir = resolve(process.argv[3] ?? join(projectRoot, 'private-assets/voice-dataset/windows-stage'));
const sourceRoot = join(projectRoot, 'private-assets/voice-source/Emilia');
const rows = (await readFile(manifestPath, 'utf8'))
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map(JSON.parse);

const staged = [];
for (const row of rows) {
  const sourceFile = resolve(sourceRoot, row.sourcePath);
  if (!sourceFile.startsWith(`${sourceRoot}/`)) throw new Error(`Unsafe source path: ${row.sourcePath}`);
  const targetFile = join(stageDir, 'wavs', row.sourcePath);
  await mkdir(dirname(targetFile), { recursive: true });
  await copyFile(sourceFile, targetFile);
  staged.push({ ...row, audioPath: `wavs/${row.sourcePath}` });
}

await writeFile(join(stageDir, 'dataset.jsonl'), `${staged.map((row) => JSON.stringify(row)).join('\n')}\n`);
await writeFile(join(stageDir, 'README.txt'), [
  'Emilia private local TTS training package',
  `clips=${staged.length}`,
  'The audio was filtered to strict solo-emilia filenames.',
  'Do not publish, commit, upload, or relay these audio files.',
  'Transcribe dataset.jsonl entries on the Windows training machine before training.',
  '',
].join('\n'));
console.log(`Staged ${staged.length} clips in ${stageDir}`);

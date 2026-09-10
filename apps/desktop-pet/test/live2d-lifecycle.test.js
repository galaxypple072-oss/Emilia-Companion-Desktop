import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Live2D outfit swaps use an instance-owned render loop", async () => {
  const source = await readFile(new URL("../src/live2d-pet.js", import.meta.url), "utf8");
  assert.match(source, /autoAnimate:\s*false/);
  assert.match(source, /function stopRenderLoop\(\)/);
  assert.match(source, /candidate !== model/);
  assert.match(source, /stopRenderLoop\(\);\s*model = null;\s*destroyModel\(previousModel\)/);
});

test("Live2D exposes the renderer's audio-driven lip-sync channel", async () => {
  const source = await readFile(new URL("../src/live2d-pet.js", import.meta.url), "utf8");
  assert.match(source, /async function startLipSync\(audioData\)/);
  assert.match(source, /await model\.inputAudio\(audioData\.slice\(0\)\)/);
  assert.match(source, /function stopLipSync\(\)/);
});

test("Live2D keeps its aspect ratio when compact mode changes the window height", async () => {
  const source = await readFile(new URL("../src/live2d-pet.js", import.meta.url), "utf8");
  assert.match(source, /keepAspect:\s*true/);
  assert.match(source, /function refreshLayout\(\)/);
  assert.match(source, /refreshLayout,/);
});

test("runtime errors after readiness do not cover the pet with a fatal card", async () => {
  const source = await readFile(new URL("../src/startup-diagnostics.js", import.meta.url), "utf8");
  assert.match(source, /fatal = !ready/);
  assert.match(source, /if \(!fatal\)/);
  assert.match(source, /formatIssue/);
});

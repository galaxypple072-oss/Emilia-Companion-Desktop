import test from "node:test";
import assert from "node:assert/strict";
import { samplingFor } from "../src/sampling.ts";
import { presetForEmotion, resolvePreset } from "../src/presets.ts";

test("short Japanese phrases use a stable, non-greedy profile", () => {
  const first = samplingFor("おはよう");
  const second = samplingFor("おはよう");
  assert.equal(first.profile, "short");
  assert.equal(first.topK, 4);
  assert.notEqual(first.topK, 1);
  assert.deepEqual(first, second);
});

test("longer lines retain the expressive profile", () => {
  const result = samplingFor("今日はスバルやみんなに私の誕生日をお祝いしてもらえて、すごーく嬉しい！");
  assert.equal(result.profile, "long");
  assert.equal(result.topK, 15);
});

test("neutral safely falls back until the user-owned natural clip is configured", () => {
  assert.equal(presetForEmotion("happy"), "bright");
  const resolved = resolvePreset("natural", undefined);
  assert.equal(resolved.preset.id, "gentle");
  assert.equal(resolved.fallbackFrom, "natural");
});

test("rejects unknown runtime emotion and preset values with clear errors", () => {
  assert.throws(() => presetForEmotion("gentle" as never), /emotion must be/);
  assert.throws(() => resolvePreset("unknown" as never, undefined), /preset must be/);
});

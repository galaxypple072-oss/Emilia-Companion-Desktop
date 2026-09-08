import assert from "node:assert/strict";
import test from "node:test";

import { pointerToGaze } from "../src/mouse-tracker.js";

test("centers gaze inside the face dead zone", () => {
  assert.deepEqual(pointerToGaze({ x: 108, y: 96 }, { x: 100, y: 100 }), { x: 0, y: 0 });
});

test("maps desktop-down to Cubism-down and clamps subtle head movement", () => {
  const gaze = pointerToGaze({ x: 2000, y: 2000 }, { x: 100, y: 100 });
  assert.equal(gaze.x, 0.48);
  assert.equal(gaze.y, -0.34);
});

test("tracks all four directions without exceeding configured limits", () => {
  const gaze = pointerToGaze(
    { x: -300, y: -200 },
    { x: 100, y: 100 },
    { radiusX: 400, radiusY: 300, limitX: 0.4, limitY: 0.25, deadZone: 0 },
  );
  assert.deepEqual(gaze, { x: -0.4, y: 0.25 });
});

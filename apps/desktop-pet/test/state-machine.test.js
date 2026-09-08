import assert from "node:assert/strict";
import test from "node:test";
import { ANIMATIONS, PET_STATES, PetAnimationController, framePath, isPetState } from "../src/state-machine.js";

test("defines the four desktop-pet states and stable frame paths", () => {
  assert.deepEqual(Object.keys(ANIMATIONS), ["idle", "walk-left", "walk-right", "casting"]);
  assert.equal(isPetState(PET_STATES.CASTING), true);
  assert.equal(isPetState("unknown"), false);
  assert.equal(framePath(PET_STATES.WALK_RIGHT, 7), "./assets/walk-right/frames/07.png");
  assert.throws(() => framePath(PET_STATES.IDLE, 8), /Invalid frame/u);
});

test("loops idle and walking states", () => {
  const controller = new PetAnimationController();
  controller.advance(ANIMATIONS.idle.delayMs * 8);
  assert.deepEqual(controller.snapshot, { state: "idle", frame: 0, src: "./assets/idle/frames/00.png" });
  controller.setState(PET_STATES.WALK_LEFT);
  controller.advance(ANIMATIONS[PET_STATES.WALK_LEFT].delayMs * 9);
  assert.equal(controller.snapshot.state, PET_STATES.WALK_LEFT);
  assert.equal(controller.snapshot.frame, 1);
});

test("returns to idle after one casting cycle", () => {
  const controller = new PetAnimationController();
  controller.setState(PET_STATES.CASTING);
  controller.advance(ANIMATIONS.casting.delayMs * 7);
  assert.equal(controller.snapshot.frame, 7);
  controller.advance(ANIMATIONS.casting.delayMs);
  assert.deepEqual(controller.snapshot, { state: "idle", frame: 0, src: "./assets/idle/frames/00.png" });
});

test("notifies subscribers only when visible animation state changes", () => {
  const controller = new PetAnimationController();
  const events = [];
  const unsubscribe = controller.subscribe((snapshot) => events.push(`${snapshot.state}:${snapshot.frame}`));
  assert.equal(controller.setState(PET_STATES.IDLE), false);
  controller.advance(179);
  controller.advance(1);
  controller.setState(PET_STATES.CASTING);
  unsubscribe();
  controller.advance(160);
  assert.deepEqual(events, ["idle:0", "idle:1", "casting:0"]);
});

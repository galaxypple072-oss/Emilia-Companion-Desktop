export const PET_STATES = Object.freeze({
  IDLE: "idle",
  WALK_LEFT: "walk-left",
  WALK_RIGHT: "walk-right",
  CASTING: "casting",
});

export const ANIMATIONS = Object.freeze({
  [PET_STATES.IDLE]: Object.freeze({ frameCount: 8, delayMs: 180, loop: true }),
  [PET_STATES.WALK_LEFT]: Object.freeze({ frameCount: 8, delayMs: 120, loop: true }),
  [PET_STATES.WALK_RIGHT]: Object.freeze({ frameCount: 8, delayMs: 120, loop: true }),
  [PET_STATES.CASTING]: Object.freeze({ frameCount: 8, delayMs: 160, loop: false }),
});

export function isPetState(value) {
  return typeof value === "string" && Object.hasOwn(ANIMATIONS, value);
}

export function framePath(state, frame) {
  if (!isPetState(state)) throw new Error(`Unknown pet state: ${String(state)}`);
  if (!Number.isInteger(frame) || frame < 0 || frame >= ANIMATIONS[state].frameCount) {
    throw new Error(`Invalid frame ${String(frame)} for ${state}`);
  }
  return `./assets/${state}/frames/${String(frame).padStart(2, "0")}.png`;
}

export class PetAnimationController {
  #state = PET_STATES.IDLE;
  #frame = 0;
  #elapsedMs = 0;
  #listeners = new Set();

  get snapshot() {
    return Object.freeze({ state: this.#state, frame: this.#frame, src: framePath(this.#state, this.#frame) });
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => this.#listeners.delete(listener);
  }

  setState(nextState, { restart = false } = {}) {
    if (!isPetState(nextState)) throw new Error(`Unknown pet state: ${String(nextState)}`);
    if (nextState === this.#state && !restart) return false;
    this.#state = nextState;
    this.#frame = 0;
    this.#elapsedMs = 0;
    this.#emit();
    return true;
  }

  advance(deltaMs) {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new Error("deltaMs must be a non-negative finite number");
    const definition = ANIMATIONS[this.#state];
    this.#elapsedMs += deltaMs;
    const elapsedFrames = Math.floor(this.#elapsedMs / definition.delayMs);
    if (elapsedFrames === 0) return this.snapshot;

    this.#elapsedMs %= definition.delayMs;
    if (definition.loop) {
      this.#frame = (this.#frame + elapsedFrames) % definition.frameCount;
    } else if (this.#frame + elapsedFrames < definition.frameCount) {
      this.#frame += elapsedFrames;
    } else {
      this.#state = PET_STATES.IDLE;
      this.#frame = 0;
      this.#elapsedMs = 0;
    }
    const changed = true;
    if (changed) this.#emit();
    return this.snapshot;
  }

  #emit() {
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}

import { Live2DCubismModel } from "live2d-renderer";

const CORE_URL = new URL("./assets/vendor/live2dcubismcore.min.js", window.location.href).href;

const STATE_MOTIONS = Object.freeze({
  idle: "Idle",
  "walk-left": "Think",
  "walk-right": "Smile",
  casting: "Surprise",
});

const VIEW_PRESETS = Object.freeze({
  half: Object.freeze({ scale: 1.8, x: 0, y: 170 }),
  full: Object.freeze({ scale: 0.92, x: 0, y: 0 }),
});

function createRenderer(canvas) {
  return new Live2DCubismModel(canvas, {
    // live2d-renderer 0.6.6 stores its RAF id at module scope. During an
    // outfit swap an old model can therefore keep rendering after destroy()
    // and touch released Cubism objects. Drive the loop per pet instead.
    autoAnimate: false,
    autoInteraction: false,
    tapInteraction: false,
    randomMotion: false,
    keepAspect: false,
    cubismCorePath: CORE_URL,
    zoomEnabled: false,
    enablePan: false,
    checkMocConsistency: true,
    premultipliedAlpha: true,
    maxTextureSize: 2048,
    enablePhysics: false,
    enableEyeblink: true,
    enableBreath: true,
    enableLipsync: true,
    scale: 1,
  });
}

export async function createLive2DPet(canvas, { outfit: initialOutfit } = {}) {
  if (!initialOutfit?.model) throw new Error("缺少初始 Live2D 服装");
  const renderScale = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
  canvas.style.setProperty("--render-scale", String(renderScale));
  canvas.style.width = `${renderScale * 100}%`;
  canvas.style.height = `${renderScale * 100}%`;
  canvas.style.transform = `scale(${1 / renderScale})`;

  let model = null;
  let neutral = Object.freeze({ x: 0, y: 0 });
  let currentView = "half";
  let currentFraming = null;
  let currentState = "idle";
  let currentOutfit = null;
  let outfitQueue = Promise.resolve();
  let animationFrame = 0;
  let renderGeneration = 0;

  function stopRenderLoop() {
    renderGeneration += 1;
    if (animationFrame) window.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  }

  function startRenderLoop(candidate) {
    stopRenderLoop();
    const generation = renderGeneration;
    const render = () => {
      if (generation !== renderGeneration || candidate !== model || !candidate.loaded) return;
      try {
        candidate.update();
      } catch (error) {
        stopRenderLoop();
        console.error("[live2d] render loop stopped safely", error);
        return;
      }
      animationFrame = window.requestAnimationFrame(render);
    };
    animationFrame = window.requestAnimationFrame(render);
  }

  function destroyModel(candidate) {
    if (!candidate) return;
    try {
      candidate.paused = true;
      candidate.stopMotions();
      candidate.destroy();
    } catch (error) {
      console.warn("[live2d] renderer cleanup was incomplete", error);
    }
  }

  function applyFraming(framing) {
    const scale = Number(framing?.scale);
    const x = Number(framing?.x);
    const y = Number(framing?.y);
    if (!model || ![scale, x, y].every(Number.isFinite) || scale < 0.4 || scale > 3) return false;
    model.scale = scale;
    model.x = neutral.x + x * renderScale;
    model.y = neutral.y + y * renderScale;
    currentFraming = Object.freeze({ scale, x, y });
    return true;
  }

  function setView(view = "half") {
    const preset = VIEW_PRESETS[view];
    if (!preset || !applyFraming(preset)) return false;
    currentView = view;
    return true;
  }

  async function play(group, index = null, priority = 3) {
    if (!model) return null;
    try {
      if (index === null) return await model.startRandomMotion(group, priority);
      return await model.startMotion(group, index, priority);
    } catch (error) {
      console.warn(`[live2d] motion ${group} failed`, error);
      return null;
    }
  }

  function setState(state, { restart = false } = {}) {
    const group = STATE_MOTIONS[state] ?? "Idle";
    if (state === currentState && !restart) return false;
    currentState = state;
    void play(group, null, state === "idle" ? 1 : 3);
    return true;
  }

  async function loadOutfit(outfit) {
    if (!outfit?.model) throw new Error("服装资源无效");
    if (currentOutfit?.id === outfit.id && model) return currentOutfit;
    const previousOutfit = currentOutfit;
    const previousModel = model;
    stopRenderLoop();
    model = null;
    destroyModel(previousModel);
    let candidate = createRenderer(canvas);
    try {
      await candidate.load(outfit.model);
    } catch (error) {
      destroyModel(candidate);
      candidate = null;
      if (previousOutfit?.model && previousOutfit.id !== outfit.id) {
        candidate = createRenderer(canvas);
        await candidate.load(previousOutfit.model);
        model = candidate;
        currentOutfit = previousOutfit;
        startRenderLoop(model);
      }
      throw error;
    }
    model = candidate;
    model.scale = 1;
    model.appendYOffset = 0;
    model.centerModel();
    neutral = Object.freeze({ x: model.x, y: model.y });
    currentOutfit = outfit;
    setView(currentView);
    setState(currentState, { restart: true });
    startRenderLoop(model);
    return outfit;
  }

  function setOutfit(outfit) {
    outfitQueue = outfitQueue.catch(() => undefined).then(() => loadOutfit(outfit));
    return outfitQueue;
  }

  function motion(group, index = null) {
    return play(group, index, 3);
  }

  // live2d-renderer calculates RMS from this same audio buffer in its render
  // loop and applies it to ParamMouthOpenY.  Keep this behind the pet
  // controller so callers never need to reach into a particular renderer.
  async function startLipSync(audioData) {
    if (!model?.loaded || !(audioData instanceof ArrayBuffer)) return false;
    try {
      // decodeAudioData may detach its input buffer in some WebViews; use a
      // private copy so the playback path can continue using its own bytes.
      await model.inputAudio(audioData.slice(0));
      return true;
    } catch (error) {
      console.warn("[live2d] lip sync audio could not be decoded", error);
      return false;
    }
  }

  function stopLipSync() {
    if (!model?.loaded) return;
    void model.stopAudio().catch((error) => {
      console.warn("[live2d] lip sync cleanup was incomplete", error);
    });
  }

  function lookAt(x, y) {
    if (!model) return;
    const horizontal = Math.min(Math.max(Number(x) || 0, -0.48), 0.48);
    const vertical = Math.min(Math.max(Number(y) || 0, -0.34), 0.34);
    model.setDragging(horizontal, vertical);
  }

  function destroy() {
    stopRenderLoop();
    const candidate = model;
    model = null;
    destroyModel(candidate);
  }

  await loadOutfit(initialOutfit);
  return Object.freeze({
    setState,
    setView,
    setFraming: applyFraming,
    setOutfit,
    lookAt,
    motion,
    startLipSync,
    stopLipSync,
    destroy,
    groups: Object.freeze(Object.values(STATE_MOTIONS)),
    views: Object.freeze(Object.keys(VIEW_PRESETS)),
    get model() {
      return model;
    },
    get view() {
      return currentView;
    },
    get framing() {
      return currentFraming;
    },
    get outfit() {
      return currentOutfit;
    },
    renderScale,
  });
}

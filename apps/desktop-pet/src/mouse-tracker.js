export function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizeAxis(delta, radius, limit, deadZone) {
  const magnitude = Math.abs(delta);
  if (magnitude <= deadZone) return 0;
  const normalized = (magnitude - deadZone) / Math.max(1, radius - deadZone);
  return Math.sign(delta) * clamp(normalized, 0, limit);
}

export function pointerToGaze(
  pointer,
  face,
  { radiusX = 700, radiusY = 520, limitX = 0.48, limitY = 0.34, deadZone = 12 } = {},
) {
  const vertical = normalizeAxis(pointer.y - face.y, radiusY, limitY, deadZone);
  return Object.freeze({
    x: normalizeAxis(pointer.x - face.x, radiusX, limitX, deadZone),
    // Cubism's model coordinates point upward while desktop coordinates point down.
    y: vertical === 0 ? 0 : -vertical,
  });
}

export function createMouseTracker({ canvas, onGaze, intervalMs = 40 }) {
  let stopped = false;
  let polling = false;
  let timer = 0;
  let unlistenMoved = null;
  let windowPosition = { x: window.screenX, y: window.screenY };
  let scaleFactor = window.devicePixelRatio || 1;

  const facePosition = () => {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.27 };
  };

  const updateFromLocalPointer = (event) => {
    if (stopped) return;
    onGaze(pointerToGaze({ x: event.clientX, y: event.clientY }, facePosition()));
  };

  window.addEventListener("pointermove", updateFromLocalPointer, { passive: true });

  async function startSystemTracking() {
    const tauriWindow = window.__TAURI__?.window;
    if (!tauriWindow?.cursorPosition || !tauriWindow?.getCurrentWindow) return false;

    const currentWindow = tauriWindow.getCurrentWindow();
    const [position, factor] = await Promise.all([
      currentWindow.outerPosition(),
      currentWindow.scaleFactor(),
    ]);
    windowPosition = position;
    scaleFactor = factor;
    unlistenMoved = await currentWindow.onMoved(({ payload }) => {
      windowPosition = payload;
    });

    const poll = async () => {
      if (stopped || polling || document.hidden) return;
      polling = true;
      try {
        const cursor = await tauriWindow.cursorPosition();
        const pointer = {
          x: (cursor.x - windowPosition.x) / scaleFactor,
          y: (cursor.y - windowPosition.y) / scaleFactor,
        };
        onGaze(pointerToGaze(pointer, facePosition()));
      } catch (error) {
        console.warn("[mouse-tracker] system cursor polling failed", error);
      } finally {
        polling = false;
      }
    };

    timer = window.setInterval(poll, intervalMs);
    void poll();
    return true;
  }

  void startSystemTracking().catch((error) => {
    console.warn("[mouse-tracker] using in-window fallback", error);
  });

  return Object.freeze({
    stop() {
      if (stopped) return;
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("pointermove", updateFromLocalPointer);
      unlistenMoved?.();
      onGaze({ x: 0, y: 0 });
    },
  });
}

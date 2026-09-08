export const DEVICE_CONTROL_PROTOCOL = 1;

export const DEVICE_CAPABILITY_IDS = Object.freeze([
  "device.info",
  "notification.show",
  "url.open",
  "clipboard.write",
  "clipboard.read",
  "files.roots",
  "files.list",
  "files.search",
  "files.read_text",
  "files.read_document",
  "files.read_binary",
  "screen.capture",
]);

export const DEVICE_RESULT_CHUNK_CHARS = 24_000;
export const DEVICE_RESULT_MAX_CHUNKS = 2048;

const capabilityIds = new Set(DEVICE_CAPABILITY_IDS);

function cleanText(value, maxLength, fallback = "") {
  const text = String(value ?? "").trim().slice(0, maxLength);
  return text || fallback;
}

function cleanId(value, label = "Device ID") {
  const id = cleanText(value, 80);
  if (!/^[A-Za-z0-9_-]{3,80}$/u.test(id)) throw new Error(`${label} is malformed`);
  return id;
}

export function normalizeDeviceAnnouncement(value, expectedDeviceId) {
  if (!value || value.type !== "device.announce" || value.protocol !== DEVICE_CONTROL_PROTOCOL) {
    throw new Error("Device announcement is unsupported");
  }
  const device = value.device && typeof value.device === "object" ? value.device : {};
  const id = cleanId(device.id);
  if (expectedDeviceId && id !== expectedDeviceId) throw new Error("Device identity does not match the connection");
  const capabilities = Array.isArray(value.capabilities) ? value.capabilities : [];
  const seen = new Set();
  const normalizedCapabilities = [];
  for (const item of capabilities) {
    if (!item || typeof item !== "object" || !capabilityIds.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    normalizedCapabilities.push(Object.freeze({
      id: item.id,
      granted: item.id === "device.info" || item.granted === true,
    }));
  }
  if (!seen.has("device.info")) normalizedCapabilities.unshift(Object.freeze({ id: "device.info", granted: true }));
  return Object.freeze({
    type: "device.announce",
    protocol: DEVICE_CONTROL_PROTOCOL,
    device: Object.freeze({
      id,
      name: cleanText(device.name, 60, "Desktop"),
      platform: cleanText(device.platform, 40, "unknown"),
      arch: cleanText(device.arch, 30, "unknown"),
      appVersion: cleanText(device.appVersion, 30, "unknown"),
    }),
    capabilities: Object.freeze(normalizedCapabilities),
  });
}

export function normalizeDeviceCommand(value) {
  if (!value || value.type !== "device.command" || value.protocol !== DEVICE_CONTROL_PROTOCOL) {
    throw new Error("Device command is unsupported");
  }
  const capability = cleanText(value.capability, 60);
  if (!capabilityIds.has(capability)) throw new Error("Device capability is unsupported");
  return Object.freeze({
    type: "device.command",
    protocol: DEVICE_CONTROL_PROTOCOL,
    requestId: cleanId(value.requestId, "Request ID"),
    capability,
    input: value.input && typeof value.input === "object" && !Array.isArray(value.input) ? value.input : {},
  });
}

export function normalizeDeviceResult(value) {
  if (!value || value.type !== "device.result" || value.protocol !== DEVICE_CONTROL_PROTOCOL) {
    throw new Error("Device result is unsupported");
  }
  const result = {
    type: "device.result",
    protocol: DEVICE_CONTROL_PROTOCOL,
    requestId: cleanId(value.requestId, "Request ID"),
    ok: value.ok === true,
  };
  if (result.ok) result.output = value.output ?? null;
  else result.error = cleanText(value.error, 500, "Device command failed");
  return Object.freeze(result);
}

export function createDeviceResultMessages(requestId, value) {
  const normalizedId = cleanId(requestId, "Request ID");
  const body = JSON.stringify(value);
  if (body.length <= DEVICE_RESULT_CHUNK_CHARS) {
    return [Object.freeze({ type: "device.result", protocol: DEVICE_CONTROL_PROTOCOL, requestId: normalizedId, ...value })];
  }
  const total = Math.ceil(body.length / DEVICE_RESULT_CHUNK_CHARS);
  if (total > DEVICE_RESULT_MAX_CHUNKS) throw new Error("Device result exceeds the transfer limit");
  return Object.freeze(Array.from({ length: total }, (_, index) => Object.freeze({
    type: "device.result.chunk",
    protocol: DEVICE_CONTROL_PROTOCOL,
    requestId: normalizedId,
    index,
    total,
    data: body.slice(index * DEVICE_RESULT_CHUNK_CHARS, (index + 1) * DEVICE_RESULT_CHUNK_CHARS),
  })));
}

export function normalizeDeviceResultChunk(value) {
  if (!value || value.type !== "device.result.chunk" || value.protocol !== DEVICE_CONTROL_PROTOCOL) {
    throw new Error("Device result chunk is unsupported");
  }
  const index = Number(value.index);
  const total = Number(value.total);
  const data = String(value.data ?? "");
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 2 || total > DEVICE_RESULT_MAX_CHUNKS || index < 0 || index >= total) {
    throw new Error("Device result chunk position is malformed");
  }
  if (!data || data.length > DEVICE_RESULT_CHUNK_CHARS) throw new Error("Device result chunk data is malformed");
  return Object.freeze({
    type: "device.result.chunk",
    protocol: DEVICE_CONTROL_PROTOCOL,
    requestId: cleanId(value.requestId, "Request ID"),
    index,
    total,
    data,
  });
}

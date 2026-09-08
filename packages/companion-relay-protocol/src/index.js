const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PAIRING_PREFIX = "emilia1";
const CONNECTION_PREFIX = "emilia-connect1";

// Runtime nodes share the existing end-to-end encrypted relay.  Relay itself
// only routes frames; a Core decides which advertised capabilities it trusts.
// Keeping this contract here means a worker can be written in Node, Tauri, or
// another runtime without copying validation rules.
export const RUNTIME_NODE_ROLES = Object.freeze(["core", "client", "worker"]);
export const RUNTIME_CAPABILITIES = Object.freeze([
  "voice.synthesize",
  "qq.receive",
  "qq.send",
  "host.health",
]);

function cryptoApi() {
  const value = globalThis.crypto;
  if (!value?.subtle || !value?.getRandomValues) throw new Error("Web Crypto is unavailable");
  return value;
}

function base64UrlEncode(bytes) {
  if (globalThis.Buffer) return globalThis.Buffer.from(bytes).toString("base64url");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Pairing secret is malformed");
  if (globalThis.Buffer) return new Uint8Array(globalThis.Buffer.from(value, "base64url"));
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function cleanId(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{3,80}$/u.test(normalized)) throw new Error(`${label} is malformed`);
  return normalized;
}

function cleanRuntimeName(value) {
  const normalized = String(value ?? "").trim().replaceAll(/\s+/gu, " ");
  if (!normalized || normalized.length > 60) throw new Error("Runtime node name is malformed");
  return normalized;
}

function cleanCapabilities(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("Runtime node must advertise at least one capability");
  const capabilities = [...new Set(value.map((item) => String(item ?? "").trim()))].sort();
  if (capabilities.some((item) => !RUNTIME_CAPABILITIES.includes(item))) {
    throw new Error("Runtime node advertises an unsupported capability");
  }
  return Object.freeze(capabilities);
}

/**
 * Creates the encrypted payload a non-Core capability process sends after it
 * connects. This is deliberately a payload, not relay metadata: capabilities
 * stay invisible to the relay server and can be policy-checked by Core.
 */
export function createRuntimeAnnouncement({ nodeId, name, capabilities, version = 1 }) {
  if (version !== 1) throw new Error("Runtime node protocol is unsupported");
  return Object.freeze({
    type: "runtime.announce",
    protocol: 1,
    nodeId: cleanId(nodeId, "Runtime node ID"),
    name: cleanRuntimeName(name),
    capabilities: cleanCapabilities(capabilities),
  });
}

export function parseRuntimeAnnouncement(value) {
  if (!value || value.type !== "runtime.announce" || value.protocol !== 1) {
    throw new Error("Runtime node announcement is unsupported");
  }
  return createRuntimeAnnouncement(value);
}

export function createPairingCode(deviceId = cryptoApi().randomUUID()) {
  const secret = cryptoApi().getRandomValues(new Uint8Array(32));
  return `${PAIRING_PREFIX}.${cleanId(deviceId, "Device ID")}.${base64UrlEncode(secret)}`;
}

export function parsePairingCode(value) {
  const [prefix, rawDeviceId, rawSecret, ...extra] = String(value ?? "").trim().split(".");
  if (prefix !== PAIRING_PREFIX || !rawDeviceId || !rawSecret || extra.length) throw new Error("Pairing code is invalid");
  const secret = base64UrlDecode(rawSecret);
  if (secret.byteLength !== 32) throw new Error("Pairing code must contain a 256-bit secret");
  return Object.freeze({ version: 1, deviceId: cleanId(rawDeviceId, "Device ID"), secret });
}

function normalizeConnectionRelayUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("Relay URL is required");
  const url = new URL(raw);
  if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("Relay URL must use ws:// or wss://");
  if (url.username || url.password) throw new Error("Relay URL cannot contain credentials");
  url.hash = "";
  return url.toString();
}

export function createConnectionCode({ url, pairingCode }) {
  const payload = {
    version: 1,
    mode: "relay",
    url: normalizeConnectionRelayUrl(url),
    pairingCode: String(pairingCode ?? "").trim(),
  };
  parsePairingCode(payload.pairingCode);
  return `${CONNECTION_PREFIX}.${base64UrlEncode(encoder.encode(JSON.stringify(payload)))}`;
}

export function parseConnectionCode(value) {
  const raw = String(value ?? "").trim();
  const [prefix, encoded, ...extra] = raw.split(".");
  if (prefix !== CONNECTION_PREFIX || !encoded || extra.length) throw new Error("Connection code is invalid");
  let payload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlDecode(encoded)));
  } catch {
    throw new Error("Connection code is invalid");
  }
  if (payload?.version !== 1 || payload?.mode !== "relay") throw new Error("Connection code is unsupported");
  const pairingCode = String(payload.pairingCode ?? "").trim();
  parsePairingCode(pairingCode);
  return Object.freeze({ mode: "relay", url: normalizeConnectionRelayUrl(payload.url), pairingCode });
}

async function hmac(secret, context) {
  const key = await cryptoApi().subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await cryptoApi().subtle.sign("HMAC", key, encoder.encode(context)));
}

export async function deriveRelayCredentials(pairingCode) {
  const parsed = parsePairingCode(pairingCode);
  const auth = await hmac(parsed.secret, `emilia-relay-auth-v1:${parsed.deviceId}`);
  const encryption = await hmac(parsed.secret, `emilia-relay-e2ee-v1:${parsed.deviceId}`);
  const encryptionKey = await cryptoApi().subtle.importKey("raw", encryption, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return Object.freeze({ deviceId: parsed.deviceId, authToken: base64UrlEncode(auth), encryptionKey });
}

function associatedData(envelope) {
  return encoder.encode([
    String(envelope.version), envelope.deviceId, envelope.messageId, envelope.senderId, envelope.recipientId,
  ].join("|"));
}

export async function sealRelayPayload(credentials, { senderId, recipientId, payload, messageId = cryptoApi().randomUUID() }) {
  const envelope = {
    type: "relay.frame",
    version: 1,
    deviceId: cleanId(credentials.deviceId, "Device ID"),
    messageId: cleanId(messageId, "Message ID"),
    senderId: cleanId(senderId, "Sender ID"),
    recipientId: recipientId === "*" ? "*" : cleanId(recipientId, "Recipient ID"),
  };
  const nonce = cryptoApi().getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await cryptoApi().subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: associatedData(envelope), tagLength: 128 },
    credentials.encryptionKey,
    plaintext,
  );
  return Object.freeze({ ...envelope, nonce: base64UrlEncode(nonce), ciphertext: base64UrlEncode(new Uint8Array(ciphertext)) });
}

export async function openRelayPayload(credentials, envelope) {
  if (!envelope || envelope.type !== "relay.frame" || envelope.version !== 1) throw new Error("Relay frame is unsupported");
  if (envelope.deviceId !== credentials.deviceId) throw new Error("Relay frame targets another device");
  const metadata = {
    version: 1,
    deviceId: cleanId(envelope.deviceId, "Device ID"),
    messageId: cleanId(envelope.messageId, "Message ID"),
    senderId: cleanId(envelope.senderId, "Sender ID"),
    recipientId: envelope.recipientId === "*" ? "*" : cleanId(envelope.recipientId, "Recipient ID"),
  };
  const nonce = base64UrlDecode(String(envelope.nonce ?? ""));
  if (nonce.byteLength !== 12) throw new Error("Relay frame nonce is invalid");
  const ciphertext = base64UrlDecode(String(envelope.ciphertext ?? ""));
  try {
    const plaintext = await cryptoApi().subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: associatedData(metadata), tagLength: 128 },
      credentials.encryptionKey,
      ciphertext,
    );
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error("Relay frame authentication failed");
  }
}

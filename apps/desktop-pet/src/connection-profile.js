import { connectionConfigFingerprint, validateConnectionConfig } from "./connection-client.js";

export const CONNECTION_PROFILE_KEY = "emilia.connection.profile.v3";
export const PREVIOUS_CONNECTION_PROFILE_KEY = "emilia.bridge.profile.v2";
export const LEGACY_CONNECTION_KEY = "emilia.bridge.config.v1";

export function defaultClientName(platform = globalThis.navigator?.platform || "") {
  if (/win/iu.test(platform)) return "我的 Windows";
  if (/mac/iu.test(platform)) return "我的 Mac";
  if (/linux/iu.test(platform)) return "我的 Linux";
  return "我的电脑";
}

function parsed(storage, key) {
  try { return JSON.parse(storage.getItem(key) || "null"); } catch { return null; }
}

export function normalizeStoredConnectionProfile(value, platform) {
  if (!value || typeof value !== "object") return null;
  try {
    const config = validateConnectionConfig({ ...value, mode: value.mode || "direct", name: value.name || defaultClientName(platform) });
    return Object.freeze({
      ...config,
      verifiedAt: Number(value.verifiedAt) || null,
      serverName: String(value.serverName || "").slice(0, 60),
    });
  } catch {
    return null;
  }
}

export function loadConnectionProfile(storage = localStorage, platform) {
  const current = parsed(storage, CONNECTION_PROFILE_KEY);
  const legacy = current ?? parsed(storage, PREVIOUS_CONNECTION_PROFILE_KEY) ?? parsed(storage, LEGACY_CONNECTION_KEY);
  return normalizeStoredConnectionProfile(legacy, platform);
}

export function createConnectionProfile(config, verification) {
  const normalized = validateConnectionConfig(config);
  if (!verification || verification.fingerprint !== connectionConfigFingerprint(normalized)) {
    throw new Error("请先测试当前连接配置");
  }
  const profile = {
    ...normalized,
    verifiedAt: Number(verification.verifiedAt) || Date.now(),
    serverName: String(verification.serverName || "Emilia Core").slice(0, 60),
  };
  return Object.freeze(profile);
}

export function clearConnectionProfile(storage = localStorage) {
  storage.removeItem(CONNECTION_PROFILE_KEY);
  storage.removeItem(PREVIOUS_CONNECTION_PROFILE_KEY);
  storage.removeItem(LEGACY_CONNECTION_KEY);
}

export function saveConnectionProfile(config, verification, storage = localStorage) {
  const profile = createConnectionProfile(config, verification);
  storage.setItem(CONNECTION_PROFILE_KEY, JSON.stringify(profile));
  storage.removeItem(PREVIOUS_CONNECTION_PROFILE_KEY);
  storage.removeItem(LEGACY_CONNECTION_KEY);
  return profile;
}

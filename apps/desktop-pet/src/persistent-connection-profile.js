import {
  clearConnectionProfile,
  createConnectionProfile,
  loadConnectionProfile,
  normalizeStoredConnectionProfile,
  saveConnectionProfile,
} from "./connection-profile.js";

function tauriInvoke() {
  return globalThis.__TAURI__?.core?.invoke ?? null;
}

export async function loadPersistentConnectionProfile({
  storage = globalThis.localStorage,
  platform = globalThis.navigator?.platform || "",
  invoke = tauriInvoke(),
} = {}) {
  const localProfile = loadConnectionProfile(storage, platform);
  if (!invoke) return localProfile;
  try {
    const stored = await invoke("load_connection_profile");
    if (typeof stored === "string" && stored) {
      const profile = normalizeStoredConnectionProfile(JSON.parse(stored), platform);
      if (profile) return profile;
    }
    if (localProfile) {
      await invoke("save_connection_profile", { profileJson: JSON.stringify(localProfile) });
      clearConnectionProfile(storage);
    }
  } catch (error) {
    console.warn("[desktop] secure profile load failed; using WebView storage", error);
  }
  return localProfile;
}

export async function savePersistentConnectionProfile(config, verification, {
  storage = globalThis.localStorage,
  invoke = tauriInvoke(),
} = {}) {
  const profile = createConnectionProfile(config, verification);
  if (!invoke) return saveConnectionProfile(config, verification, storage);
  try {
    await invoke("save_connection_profile", { profileJson: JSON.stringify(profile) });
    clearConnectionProfile(storage);
    return profile;
  } catch (error) {
    console.warn("[desktop] secure profile save failed; using WebView storage", error);
    return saveConnectionProfile(config, verification, storage);
  }
}

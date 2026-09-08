import assert from "node:assert/strict";
import test from "node:test";
import { createPairingCode } from "../../../packages/companion-relay-protocol/src/index.js";
import { CONNECTION_PROFILE_KEY } from "../src/connection-profile.js";
import { loadPersistentConnectionProfile, savePersistentConnectionProfile } from "../src/persistent-connection-profile.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function relayProfile() {
  return {
    mode: "relay",
    url: "wss://relay.example.test/private",
    token: createPairingCode("home-core"),
    name: "我的 Mac",
    verifiedAt: 1234,
    serverName: "Emilia 私密中继",
  };
}

test("migrates a WebView profile into the operating-system credential store", async () => {
  const profile = relayProfile();
  const storage = memoryStorage({ [CONNECTION_PROFILE_KEY]: JSON.stringify(profile) });
  let secureProfile = null;
  const invoke = async (command, payload) => {
    if (command === "load_connection_profile") return null;
    if (command === "save_connection_profile") secureProfile = payload.profileJson;
  };
  assert.deepEqual(await loadPersistentConnectionProfile({ storage, platform: "MacIntel", invoke }), profile);
  assert.deepEqual(JSON.parse(secureProfile), profile);
  assert.equal(storage.getItem(CONNECTION_PROFILE_KEY), null);
});

test("loads the credential-store profile across WebView origins", async () => {
  const profile = relayProfile();
  const loaded = await loadPersistentConnectionProfile({
    storage: memoryStorage(),
    platform: "MacIntel",
    invoke: async () => JSON.stringify(profile),
  });
  assert.deepEqual(loaded, profile);
});

test("saves verified profiles without leaving the pairing secret in localStorage", async () => {
  const profile = relayProfile();
  const storage = memoryStorage();
  let saved = null;
  const result = await savePersistentConnectionProfile(profile, {
    fingerprint: `${profile.mode}\n${profile.url}\n${profile.token}\n${profile.name}`,
    verifiedAt: profile.verifiedAt,
    serverName: profile.serverName,
  }, {
    storage,
    invoke: async (_command, payload) => { saved = payload.profileJson; },
  });
  assert.equal(result.token, profile.token);
  assert.equal(JSON.parse(saved).token, profile.token);
  assert.equal(storage.getItem(CONNECTION_PROFILE_KEY), null);
});

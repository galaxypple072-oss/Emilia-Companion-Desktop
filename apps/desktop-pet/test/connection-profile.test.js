import assert from "node:assert/strict";
import test from "node:test";
import { connectionConfigFingerprint } from "../src/connection-client.js";
import {
  CONNECTION_PROFILE_KEY,
  LEGACY_CONNECTION_KEY,
  defaultClientName,
  loadConnectionProfile,
  saveConnectionProfile,
} from "../src/connection-profile.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("chooses a platform-friendly default device name", () => {
  assert.equal(defaultClientName("MacIntel"), "我的 Mac");
  assert.equal(defaultClientName("Win32"), "我的 Windows");
  assert.equal(defaultClientName("Linux x86_64"), "我的 Linux");
});

test("migrates a valid legacy profile without exposing it to chat", () => {
  const storage = memoryStorage({
    [LEGACY_CONNECTION_KEY]: JSON.stringify({ url: "10.0.0.8", token: "0123456789abcdefghijklmn", name: "MacBook" }),
  });
  assert.deepEqual(loadConnectionProfile(storage, "MacIntel"), {
    mode: "direct",
    url: "ws://10.0.0.8:8765/",
    token: "0123456789abcdefghijklmn",
    name: "MacBook",
    verifiedAt: null,
    serverName: "",
  });
});

test("saves only the exact configuration that passed authentication", () => {
  const storage = memoryStorage();
  const config = { url: "10.0.0.8", token: "0123456789abcdefghijklmn", name: "MacBook" };
  assert.throws(() => saveConnectionProfile(config, null, storage), /先测试/u);
  const profile = saveConnectionProfile(config, {
    fingerprint: connectionConfigFingerprint(config), verifiedAt: 1234, serverName: "Home Core",
  }, storage);
  assert.equal(profile.verifiedAt, 1234);
  assert.equal(loadConnectionProfile(storage)?.serverName, "Home Core");
  assert.ok(storage.getItem(CONNECTION_PROFILE_KEY));
});

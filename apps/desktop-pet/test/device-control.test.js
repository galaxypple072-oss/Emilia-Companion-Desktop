import assert from "node:assert/strict";
import test from "node:test";
import { DeviceControlAgent, loadDeviceAudit, loadDevicePermissions, saveDevicePermissions } from "../src/device-control.js";

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test("device permissions default to info only and persist explicit grants", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadDevicePermissions(storage), {
    "device.info": true,
    "notification.show": false,
    "url.open": false,
    "clipboard.write": false,
    "clipboard.read": false,
    "files.roots": false,
    "files.list": false,
    "files.search": false,
    "files.read_text": false,
    "files.read_document": false,
    "files.read_binary": false,
    "screen.capture": false,
  });
  saveDevicePermissions({ "url.open": true }, storage);
  assert.equal(loadDevicePermissions(storage)["url.open"], true);
  assert.equal(loadDevicePermissions(storage)["device.info"], true);
});

test("device agent exports a selected file only after the dedicated permission is granted", async () => {
  const storage = memoryStorage();
  saveDevicePermissions({ "files.read_binary": true }, storage);
  const calls = [];
  const sent = [];
  const agent = new DeviceControlAgent({
    deviceId: "mac-123", deviceName: "My Mac", platform: "MacIntel", storage,
    invoke: async (command, input) => {
      calls.push([command, input]);
      if (command === "device_get_info") return { platform: "macos" };
      return { name: "note.txt", size: 4, data: "dGVzdA==" };
    },
  });
  await agent.attach(async (event) => { sent.push(event); });
  await agent.handle({ type: "device.command", protocol: 1, requestId: "request-file", capability: "files.read_binary", input: { path: "/allowed/note.txt" } });
  assert.deepEqual(calls.at(-1), ["device_read_binary_file", { path: "/allowed/note.txt" }]);
  assert.equal(sent.at(-1).ok, true);
});

test("device agent announces grants and executes only allowlisted commands", async () => {
  const storage = memoryStorage();
  saveDevicePermissions({ "clipboard.write": true }, storage);
  const calls = [];
  const sent = [];
  const agent = new DeviceControlAgent({
    deviceId: "mac-123", deviceName: "My Mac", platform: "MacIntel", storage,
    invoke: async (command, input) => {
      calls.push([command, input]);
      if (command === "device_get_info") return { platform: "macos", arch: "aarch64", appVersion: "0.0.1" };
      return null;
    },
  });
  await agent.attach(async (event) => { sent.push(event); });
  assert.equal(sent[0].type, "device.announce");
  assert.equal(sent[0].capabilities.find((item) => item.id === "clipboard.write").granted, true);

  await agent.handle({ type: "device.command", protocol: 1, requestId: "request-123", capability: "clipboard.write", input: { text: "hello" } });
  assert.deepEqual(calls.at(-1), ["device_write_clipboard", { text: "hello" }]);
  assert.equal(sent.at(-1).ok, true);

  await agent.handle({ type: "device.command", protocol: 1, requestId: "request-456", capability: "clipboard.read", input: {} });
  assert.equal(sent.at(-1).ok, false);
  assert.match(sent.at(-1).error, /尚未/u);
  assert.deepEqual(loadDeviceAudit(storage).map((item) => [item.capability, item.ok]), [
    ["clipboard.write", true],
    ["clipboard.read", false],
  ]);
});

test("device agent refuses non-http URLs before invoking the operating system", async () => {
  const storage = memoryStorage();
  saveDevicePermissions({ "url.open": true }, storage);
  const sent = [];
  const calls = [];
  const agent = new DeviceControlAgent({
    deviceId: "mac-123", deviceName: "My Mac", platform: "MacIntel", storage,
    invoke: async (command) => { calls.push(command); return { platform: "macos" }; },
  });
  await agent.attach(async (event) => { sent.push(event); });
  await agent.handle({ type: "device.command", protocol: 1, requestId: "request-789", capability: "url.open", input: { url: "file:///etc/passwd" } });
  assert.equal(sent.at(-1).ok, false);
  assert.equal(calls.includes("device_open_url"), false);
});

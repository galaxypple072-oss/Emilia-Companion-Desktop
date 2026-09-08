import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVICE_CONTROL_PROTOCOL,
  normalizeDeviceAnnouncement,
  normalizeDeviceCommand,
  normalizeDeviceResult,
  createDeviceResultMessages,
  normalizeDeviceResultChunk,
} from "../src/device-control.js";

test("device announcements bind capabilities to the authenticated client identity", () => {
  const announcement = normalizeDeviceAnnouncement({
    type: "device.announce",
    protocol: DEVICE_CONTROL_PROTOCOL,
    device: { id: "mac-123", name: "My Mac", platform: "macos", arch: "aarch64", appVersion: "0.0.1" },
    capabilities: [
      { id: "clipboard.read", granted: false },
      { id: "url.open", granted: true },
      { id: "shell.exec", granted: true },
    ],
  }, "mac-123");
  assert.deepEqual(announcement.capabilities, [
    { id: "device.info", granted: true },
    { id: "clipboard.read", granted: false },
    { id: "url.open", granted: true },
  ]);
  assert.throws(() => normalizeDeviceAnnouncement({ ...announcement, device: { ...announcement.device, id: "other" } }, "mac-123"), /identity/u);
});

test("large device results are split into bounded authenticated relay payloads", () => {
  const messages = createDeviceResultMessages("request-large", { ok: true, output: { data: "x".repeat(70_000) } });
  assert.equal(messages.length, 3);
  assert.equal(messages.every((item) => item.type === "device.result.chunk"), true);
  assert.equal(normalizeDeviceResultChunk(messages[0]).index, 0);
});

test("device commands reject arbitrary capabilities", () => {
  assert.deepEqual(normalizeDeviceCommand({
    type: "device.command", protocol: 1, requestId: "request-123", capability: "device.info", input: {},
  }).capability, "device.info");
  assert.throws(() => normalizeDeviceCommand({
    type: "device.command", protocol: 1, requestId: "request-123", capability: "shell.exec", input: {},
  }), /unsupported/u);
});

test("device results have bounded errors", () => {
  const result = normalizeDeviceResult({
    type: "device.result", protocol: 1, requestId: "request-123", ok: false, error: "x".repeat(800),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.length, 500);
});

import assert from "node:assert/strict";
import test from "node:test";
import { loadDeviceControlApiConfig } from "../src/device-control-api.ts";

test("device API stays loopback-only and derives a separate bearer token", () => {
  const secret = "emilia1.core-test.abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
  const config = loadDeviceControlApiConfig({ COMPANION_RELAY_PAIRING_CODE: secret, DEVICE_CONTROL_API_PORT: "9876" });
  assert.equal(config?.host, "127.0.0.1");
  assert.equal(config?.port, 9876);
  assert.notEqual(config?.token, secret);
  assert.ok((config?.token.length ?? 0) >= 40);
});

test("device API is absent without a local secret and can be disabled", () => {
  assert.equal(loadDeviceControlApiConfig({}), null);
  assert.equal(loadDeviceControlApiConfig({ DEVICE_CONTROL_ENABLED: "false", COMPANION_BRIDGE_TOKEN: "x".repeat(30) }), null);
});

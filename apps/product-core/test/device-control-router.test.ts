import assert from "node:assert/strict";
import test from "node:test";
import { DeviceControlRouter } from "../src/device-control-router.ts";

function announcement(id = "mac-123") {
  return {
    type: "device.announce", protocol: 1,
    device: { id, name: "My Mac", platform: "macos", arch: "aarch64", appVersion: "0.0.1" },
    capabilities: [{ id: "device.info", granted: true }, { id: "url.open", granted: false }],
  };
}

test("router lists announced devices without exposing transport senders", () => {
  const router = new DeviceControlRouter();
  router.register("relay:mac-123", "mac-123", "relay", announcement(), async () => {});
  const [device] = router.list();
  assert.equal(device.name, "My Mac");
  assert.equal(device.capabilities[0].id, "device.info");
  assert.equal("send" in device, false);
});

test("router completes an allowed device command from its authenticated connection", async () => {
  const router = new DeviceControlRouter();
  let outbound;
  router.register("relay:mac-123", "mac-123", "relay", announcement(), async (payload) => { outbound = payload; });
  const resultPromise = router.execute("My Mac", "device.info", {}, 500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outbound.type, "device.command");
  assert.equal(router.handleResult("relay:someone-else", { type: "device.result", protocol: 1, requestId: outbound.requestId, ok: true, output: {} }), false);
  assert.equal(router.handleResult("relay:mac-123", { type: "device.result", protocol: 1, requestId: outbound.requestId, ok: true, output: { platform: "macos" } }), true);
  assert.deepEqual(await resultPromise, { platform: "macos" });
});

test("router refuses capabilities not granted on the device", async () => {
  const router = new DeviceControlRouter();
  router.register("relay:mac-123", "mac-123", "relay", announcement(), async () => {});
  await assert.rejects(router.execute("My Mac", "url.open"), /尚未授权/u);
});

test("router reassembles chunked device results", async () => {
  const router = new DeviceControlRouter();
  let outbound: any;
  router.register("relay:mac-123", "mac-123", "relay", announcement(), async (payload) => { outbound = payload; });
  const resultPromise = router.execute("My Mac", "device.info", {}, 500);
  await new Promise((resolve) => setImmediate(resolve));
  const body = JSON.stringify({ ok: true, output: { text: "x".repeat(30_000) } });
  const parts = [body.slice(0, 24_000), body.slice(24_000)];
  assert.equal(router.handleResult("relay:mac-123", { type: "device.result.chunk", protocol: 1, requestId: outbound.requestId, index: 1, total: 2, data: parts[1] }), true);
  assert.equal(router.handleResult("relay:mac-123", { type: "device.result.chunk", protocol: 1, requestId: outbound.requestId, index: 0, total: 2, data: parts[0] }), true);
  assert.equal((await resultPromise as any).text.length, 30_000);
});

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBridgeUrl, testBridgeConnection, validateBridgeConfig } from "../src/bridge-client.js";

test("bridge config accepts LAN websocket endpoints", () => {
  assert.deepEqual(validateBridgeConfig({
    url: "ws://10.89.17.159:8765",
    token: "0123456789abcdefghijklmn",
    name: "我的 Mac",
  }), {
    url: "ws://10.89.17.159:8765/",
    token: "0123456789abcdefghijklmn",
    name: "我的 Mac",
  });
});

test("bridge config rejects HTTP URLs and short tokens", () => {
  assert.throws(() => validateBridgeConfig({ url: "http://10.0.0.1", token: "0123456789abcdefghijklmn", name: "Mac" }), /ws:\/\//);
  assert.throws(() => validateBridgeConfig({ url: "ws://10.0.0.1:8765", token: "short", name: "Mac" }), /24/);
});

test("bridge config accepts a bare host and supplies the bridge port", () => {
  assert.equal(normalizeBridgeUrl("10.89.38.169"), "ws://10.89.38.169:8765/");
  assert.equal(normalizeBridgeUrl("localhost:9000"), "ws://localhost:9000/");
});

test("connection probe authenticates before reporting success", async () => {
  class Socket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, event) { this.listeners.get(type)?.(event); }
    send(raw) {
      const event = JSON.parse(raw);
      assert.equal(event.type, "auth");
      assert.equal(event.token, "0123456789abcdefghijklmn");
      this.emit("message", { data: JSON.stringify({ type: "auth.ok", serverName: "Bedroom Core" }) });
    }
    close() {}
  }
  let now = 100;
  const result = await testBridgeConnection({
    url: "10.0.0.8",
    token: "0123456789abcdefghijklmn",
    name: "我的 Mac",
  }, { WebSocketImpl: Socket, now: () => (now += 12) });
  assert.equal(result.ok, true);
  assert.equal(result.serverName, "Bedroom Core");
  assert.equal(result.config.url, "ws://10.0.0.8:8765/");
  assert.equal(result.latencyMs, 12);
});

test("connection probe persists a replacement token issued after first pairing", async () => {
  class Socket {
    constructor() { this.listeners = new Map(); queueMicrotask(() => this.emit("open", {})); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, event) { this.listeners.get(type)?.(event); }
    send(raw) {
      const event = JSON.parse(raw);
      this.emit("message", { data: JSON.stringify({ type: "auth.ok", serverName: "Home Core", replacementToken: "replacement-token-0123456789abcdef" }) });
    }
    close() {}
  }
  const result = await testBridgeConnection({
    url: "10.0.0.8", token: "0123456789abcdefghijklmn", name: "我的 Mac",
  }, { WebSocketImpl: Socket });
  assert.equal(result.config.token, "replacement-token-0123456789abcdef");
});

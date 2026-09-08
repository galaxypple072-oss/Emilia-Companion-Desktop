import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPairingCode, deriveRelayCredentials } from "../../../packages/companion-relay-protocol/src/index.js";
import { normalizeRelayUrl, testRelayConnection, validateRelayConfig } from "../src/relay-client.js";

test("relay config uses a pairing code instead of exposing the encryption key", () => {
  const pairingCode = createPairingCode("home-core");
  assert.deepEqual(validateRelayConfig({ url: "relay.example.test/connect", token: pairingCode, name: "我的 Mac" }), {
    mode: "relay",
    url: "wss://relay.example.test/connect",
    token: pairingCode,
    name: "我的 Mac",
  });
  assert.equal(normalizeRelayUrl("ws://127.0.0.1:8876"), "ws://127.0.0.1:8876/");
});

test("relay probe sends only the derived routing credential", async () => {
  const pairingCode = createPairingCode("probe-core");
  const credentials = await deriveRelayCredentials(pairingCode);
  class Socket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, event) { this.listeners.get(type)?.(event); }
    send(raw) {
      assert.equal(raw.includes(pairingCode), false);
      const event = JSON.parse(raw);
      assert.equal(event.authToken, credentials.authToken);
      this.emit("message", { data: JSON.stringify({ type: "relay.auth.ok" }) });
    }
    close() {}
  }
  const result = await testRelayConnection({ url: "ws://relay.test", token: pairingCode, name: "Mac" }, { WebSocketImpl: Socket });
  assert.equal(result.ok, true);
});

test("relay client serializes async frame processing for ordered audio transfers", async () => {
  const source = await readFile(new URL("../src/relay-client.js", import.meta.url), "utf8");
  assert.match(source, /this\.receiveChain = Promise\.resolve\(\)/);
  assert.match(source, /this\.receiveChain = this\.receiveChain\s*\.then\(\(\) => this\.receive\(socket, message\)\)/);
});

test("relay client retries while Windows Core is still registering", async () => {
  const source = await readFile(new URL("../src/relay-client.js", import.meta.url), "utf8");
  assert.match(source, /event\.message === "Core is not registered"/);
  assert.match(source, /label: "正在等待 Core"/);
  assert.match(source, /socket\.close\(4004, "Core is not registered"\)/);
});

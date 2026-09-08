import assert from "node:assert/strict";
import test from "node:test";
import { createPairingCode } from "../../../packages/companion-relay-protocol/src/index.js";
import { loadCompanionRelayConfig } from "../src/relay-companion-endpoint.ts";

test("relay endpoint remains disabled by default", () => {
  assert.equal(loadCompanionRelayConfig({}), null);
});

test("relay endpoint validates URL and pairing code without changing direct bridge config", () => {
  const pairingCode = createPairingCode("private-core");
  assert.deepEqual(loadCompanionRelayConfig({
    COMPANION_RELAY_ENABLED: "true",
    COMPANION_RELAY_URL: "wss://relay.example.test/connect",
    COMPANION_RELAY_PAIRING_CODE: pairingCode,
    COMPANION_BRIDGE_NAME: "My Local Core",
  }), {
    url: "wss://relay.example.test/connect",
    pairingCode,
    serverName: "My Local Core",
  });
  assert.throws(() => loadCompanionRelayConfig({
    COMPANION_RELAY_ENABLED: "true",
    COMPANION_RELAY_URL: "https://relay.example.test",
    COMPANION_RELAY_PAIRING_CODE: pairingCode,
  }), /ws:\/\//);
});

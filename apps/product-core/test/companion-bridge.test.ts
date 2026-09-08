import assert from "node:assert/strict";
import test from "node:test";
import { inferCompanionEmotion, loadCompanionBridgeConfig } from "../src/companion-bridge.ts";

test("bridge stays disabled unless explicitly enabled", () => {
  assert.equal(loadCompanionBridgeConfig({}), null);
});

test("bridge requires a separate long token", () => {
  assert.throws(() => loadCompanionBridgeConfig({ COMPANION_BRIDGE_ENABLED: "true", COMPANION_BRIDGE_TOKEN: "short" }), /at least 24/);
  assert.deepEqual(loadCompanionBridgeConfig({
    COMPANION_BRIDGE_ENABLED: "true",
    COMPANION_BRIDGE_TOKEN: "0123456789abcdefghijklmn",
    COMPANION_BRIDGE_PORT: "9876",
  }), {
    host: "0.0.0.0",
    port: 9876,
    token: "0123456789abcdefghijklmn",
    serverName: "Emilia Core",
  });
});

test("desktop emotion follows the assistant reply", () => {
  assert.equal(inferCompanionEmotion("嘿嘿，好耶～"), "happy");
  assert.equal(inferCompanionEmotion("让我想想"), "think");
  assert.equal(inferCompanionEmotion("诶？居然是这样"), "surprise");
  assert.equal(inferCompanionEmotion("嗯，我知道了"), "neutral");
});

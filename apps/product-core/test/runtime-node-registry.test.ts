import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeNodeRegistry } from "../src/runtime-node-registry.ts";

test("Core only accepts a worker announcement bound to its relay peer id", () => {
  const registry = new RuntimeNodeRegistry();
  const node = registry.register("windows-voice", {
    type: "runtime.announce",
    protocol: 1,
    nodeId: "windows-voice",
    name: "Windows Voice",
    capabilities: ["voice.synthesize", "host.health"],
  });
  assert.equal(node.id, "windows-voice");
  assert.deepEqual(node.capabilities, ["host.health", "voice.synthesize"]);
  assert.equal(registry.findByCapability("voice.synthesize")?.id, "windows-voice");
  assert.throws(() => registry.register("windows-voice", {
    type: "runtime.announce", protocol: 1, nodeId: "other-host", name: "Other", capabilities: ["host.health"],
  }), /must match/u);
  registry.unregister("windows-voice");
  assert.deepEqual(registry.list(), []);
});

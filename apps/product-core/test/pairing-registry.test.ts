import assert from "node:assert/strict";
import test from "node:test";
import { PairingRegistry } from "../src/pairing-registry.ts";
import { ProductStore } from "../src/store.ts";

test("an invitation is single-use and becomes an independently revocable device token", () => {
  let now = 1_000;
  const store = new ProductStore(":memory:");
  const registry = new PairingRegistry(store, () => now);
  const invitation = registry.createInvitation(60_000);
  const first = registry.authenticate(invitation.token, "My Mac");
  assert.ok(first?.replacementToken);
  assert.equal(registry.authenticate(invitation.token, "My Mac"), null);
  now += 50;
  const reconnect = registry.authenticate(first!.replacementToken!, "Renamed Mac");
  assert.equal(reconnect?.replacementToken, null);
  assert.deepEqual(registry.listDevices(), [{ id: first!.device.id, name: "Renamed Mac", createdAt: 1_000, lastSeenAt: 1_050 }]);
  assert.equal(registry.revokeDevice(first!.device.id), true);
  assert.equal(registry.authenticate(first!.replacementToken!, "Renamed Mac"), null);
  store.close();
});

test("expired invitations cannot be redeemed", () => {
  let now = 1_000;
  const store = new ProductStore(":memory:");
  const registry = new PairingRegistry(store, () => now);
  const invitation = registry.createInvitation(60_000);
  now += 60_001;
  assert.equal(registry.authenticate(invitation.token, "Too late"), null);
  store.close();
});

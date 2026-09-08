import assert from "node:assert/strict";
import test from "node:test";
import {
  createConnectionCode,
  createPairingCode,
  deriveRelayCredentials,
  openRelayPayload,
  parseConnectionCode,
  parsePairingCode,
  createRuntimeAnnouncement,
  parseRuntimeAnnouncement,
  sealRelayPayload,
} from "../src/index.js";

test("pairing code contains a stable device id and a 256-bit secret", () => {
  const pairingCode = createPairingCode("core-test-1");
  const parsed = parsePairingCode(pairingCode);
  assert.equal(parsed.deviceId, "core-test-1");
  assert.equal(parsed.secret.byteLength, 32);
});

test("connection code carries one validated relay profile", () => {
  const pairingCode = createPairingCode("home-core");
  const code = createConnectionCode({ url: "wss://relay.example.test/private", pairingCode });
  assert.equal(code.includes("relay.example.test"), false);
  assert.equal(code.includes(pairingCode), false);
  assert.deepEqual(parseConnectionCode(code), {
    mode: "relay",
    url: "wss://relay.example.test/private",
    pairingCode,
  });
});

test("connection code rejects malformed transport details", () => {
  assert.throws(() => parseConnectionCode("emilia-connect1.not-base64"), /invalid/u);
  assert.throws(() => createConnectionCode({
    url: "https://relay.example.test",
    pairingCode: createPairingCode(),
  }), /ws:\/\//u);
});

test("relay payload is opaque and authenticated end to end", async () => {
  const credentials = await deriveRelayCredentials(createPairingCode("core-test-2"));
  const frame = await sealRelayPayload(credentials, {
    senderId: "macbook",
    recipientId: "core",
    payload: { type: "chat.send", text: "这句话中继不能看到" },
  });
  assert.equal(JSON.stringify(frame).includes("这句话中继不能看到"), false);
  assert.deepEqual(await openRelayPayload(credentials, frame), { type: "chat.send", text: "这句话中继不能看到" });
  await assert.rejects(openRelayPayload(credentials, { ...frame, senderId: "attacker" }), /authentication failed/);
});

test("different pairing codes cannot decrypt each other", async () => {
  const first = await deriveRelayCredentials(createPairingCode("same-core"));
  const second = await deriveRelayCredentials(createPairingCode("same-core"));
  const frame = await sealRelayPayload(first, { senderId: "macbook", recipientId: "core", payload: { ok: true } });
  await assert.rejects(openRelayPayload(second, frame), /authentication failed/);
});

test("runtime capability announcements have one portable, strict contract", () => {
  const announcement = createRuntimeAnnouncement({
    nodeId: "windows-voice",
    name: "Windows Voice",
    capabilities: ["host.health", "voice.synthesize", "voice.synthesize"],
  });
  assert.deepEqual(announcement, {
    type: "runtime.announce",
    protocol: 1,
    nodeId: "windows-voice",
    name: "Windows Voice",
    capabilities: ["host.health", "voice.synthesize"],
  });
  assert.deepEqual(parseRuntimeAnnouncement(announcement), announcement);
  assert.throws(() => createRuntimeAnnouncement({
    nodeId: "windows-voice", name: "Windows Voice", capabilities: ["shell.execute"],
  }), /unsupported capability/u);
});

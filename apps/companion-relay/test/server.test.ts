import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { createPairingCode, deriveRelayCredentials, openRelayPayload, sealRelayPayload } from "../../../packages/companion-relay-protocol/src/index.js";
import { CompanionRelayServer } from "../src/server.ts";

function nextEvent(socket: WebSocket, expectedType: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expectedType}`)), 3000);
    const onMessage = (raw: WebSocket.RawData): void => {
      const event = JSON.parse(String(raw)) as Record<string, unknown>;
      if (event.type !== expectedType) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(event);
    };
    socket.on("message", onMessage);
  });
}

async function connect(url: string, auth: Record<string, unknown>): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const authenticated = nextEvent(socket, "relay.auth.ok");
  socket.send(JSON.stringify({ type: "relay.auth", ...auth }));
  await authenticated;
  return socket;
}

test("relay routes opaque frames between a core and its paired client", async () => {
  const controller = new AbortController();
  const relay = new CompanionRelayServer({ port: 0 });
  const running = relay.run(controller.signal);
  for (let attempt = 0; attempt < 50 && !relay.address(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const port = relay.address()?.port;
  assert.ok(port);
  const credentials = await deriveRelayCredentials(createPairingCode("relay-test-core"));
  const core = await connect(`ws://127.0.0.1:${port}`, {
    role: "core", deviceId: credentials.deviceId, peerId: "core", authToken: credentials.authToken,
  });
  const client = await connect(`ws://127.0.0.1:${port}`, {
    role: "client", deviceId: credentials.deviceId, peerId: "test-mac", authToken: credentials.authToken,
  });

  const incoming = nextEvent(core, "relay.frame");
  const frame = await sealRelayPayload(credentials, {
    senderId: "test-mac", recipientId: "core", payload: { type: "chat.send", text: "relay must not read this" },
  });
  client.send(JSON.stringify(frame));
  const routed = await incoming;
  assert.equal(JSON.stringify(routed).includes("relay must not read this"), false);
  assert.deepEqual(await openRelayPayload(credentials, routed), { type: "chat.send", text: "relay must not read this" });

  client.close();
  core.close();
  controller.abort();
  await running;
});

test("relay routes opaque frames between a core and a capability worker", async () => {
  const controller = new AbortController();
  const relay = new CompanionRelayServer({ port: 0 });
  const running = relay.run(controller.signal);
  for (let attempt = 0; attempt < 50 && !relay.address(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const port = relay.address()?.port;
  assert.ok(port);
  const credentials = await deriveRelayCredentials(createPairingCode("relay-worker-core"));
  const core = await connect(`ws://127.0.0.1:${port}`, {
    role: "core", deviceId: credentials.deviceId, peerId: "core", authToken: credentials.authToken,
  });
  const worker = await connect(`ws://127.0.0.1:${port}`, {
    role: "worker", deviceId: credentials.deviceId, peerId: "windows-voice", authToken: credentials.authToken,
  });

  const incoming = nextEvent(core, "relay.frame");
  const frame = await sealRelayPayload(credentials, {
    senderId: "windows-voice", recipientId: "core", payload: { type: "runtime.announce", protocol: 1 },
  });
  worker.send(JSON.stringify(frame));
  assert.deepEqual(await openRelayPayload(credentials, await incoming), { type: "runtime.announce", protocol: 1 });

  worker.close();
  core.close();
  controller.abort();
  await running;
});

test("a replacement Core receives the existing worker inventory", async () => {
  const controller = new AbortController();
  const relay = new CompanionRelayServer({ port: 0 });
  const running = relay.run(controller.signal);
  for (let attempt = 0; attempt < 50 && !relay.address(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const port = relay.address()?.port;
  assert.ok(port);
  const credentials = await deriveRelayCredentials(createPairingCode("relay-restart-core"));
  const firstCore = await connect(`ws://127.0.0.1:${port}`, {
    role: "core", deviceId: credentials.deviceId, peerId: "core", authToken: credentials.authToken,
  });
  const worker = await connect(`ws://127.0.0.1:${port}`, {
    role: "worker", deviceId: credentials.deviceId, peerId: "windows-voice", authToken: credentials.authToken,
  });
  const replacement = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => { replacement.once("open", resolve); replacement.once("error", reject); });
  const authenticated = nextEvent(replacement, "relay.auth.ok");
  const online = nextEvent(replacement, "relay.peer_online");
  replacement.send(JSON.stringify({
    type: "relay.auth", role: "core", deviceId: credentials.deviceId, peerId: "core", authToken: credentials.authToken,
  }));
  await authenticated;
  assert.deepEqual(await online, { type: "relay.peer_online", peerId: "windows-voice", role: "worker" });

  replacement.close();
  worker.close();
  firstCore.close();
  controller.abort();
  await running;
});

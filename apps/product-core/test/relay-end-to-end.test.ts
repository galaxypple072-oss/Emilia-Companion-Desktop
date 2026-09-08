import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { CompanionRelayServer } from "../../companion-relay/src/server.ts";
import { RelayCompanionClient } from "../../desktop-pet/src/relay-client.js";
import { DeviceControlAgent } from "../../desktop-pet/src/device-control.js";
import { createPairingCode } from "../../../packages/companion-relay-protocol/src/index.js";
import { RelayCompanionEndpoint } from "../src/relay-companion-endpoint.ts";
import { DeviceControlRouter } from "../src/device-control-router.ts";
import { RuntimeNodeRegistry } from "../src/runtime-node-registry.ts";
import { RelayVoiceWorker } from "../../voice-service/src/relay-worker.ts";

test("desktop chat reaches the unchanged Core handler through encrypted relay transport", async () => {
  const relayController = new AbortController();
  const relay = new CompanionRelayServer({ port: 0 });
  const relayRunning = relay.run(relayController.signal);
  for (let attempt = 0; attempt < 50 && !relay.address(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const port = relay.address()?.port;
  assert.ok(port);

  const pairingCode = createPairingCode("end-to-end-core");
  let receivedText = "";
  const coreController = new AbortController();
  const endpoint = new RelayCompanionEndpoint({
    url: `ws://127.0.0.1:${port}`,
    pairingCode,
    serverName: "Test Core",
  }, async (request) => {
    receivedText = request.text;
    return { chunks: ["我收到了"], emotion: "happy", intensity: 0.7, motion: "Smile" };
  });
  const coreRunning = endpoint.run(coreController.signal);

  const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for encrypted reply")), 4000);
    const client = new RelayCompanionClient({
      WebSocketImpl: WebSocket,
      clientId: "test-mac",
      onState(event) {
        if (event.state === "online") client.sendChat("通过中继说句话");
      },
      onEvent(event) {
        if (event.type !== "assistant.reply") return;
        clearTimeout(timer);
        client.disconnect();
        resolve(event);
      },
    });
    setTimeout(() => client.connect({ mode: "relay", url: `ws://127.0.0.1:${port}`, token: pairingCode, name: "测试 Mac" }), 40);
  });

  const event = await reply;
  assert.equal(receivedText, "通过中继说句话");
  assert.equal(event.text, "我收到了");
  assert.equal(event.emotion, "happy");

  coreController.abort();
  await coreRunning;
  relayController.abort();
  await relayRunning;
});

test("Core discovers and controls a locally authorized client capability over the encrypted relay", async () => {
  const relayController = new AbortController();
  const relay = new CompanionRelayServer({ port: 0 });
  const relayRunning = relay.run(relayController.signal);
  for (let attempt = 0; attempt < 50 && !relay.address(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const port = relay.address()?.port;
  assert.ok(port);

  const pairingCode = createPairingCode("device-control-core");
  const devices = new DeviceControlRouter();
  const coreController = new AbortController();
  const endpoint = new RelayCompanionEndpoint({
    url: `ws://127.0.0.1:${port}`,
    pairingCode,
    serverName: "Test Core",
  }, async () => ({ chunks: [], emotion: "neutral", intensity: 0, motion: "Idle" }), devices);
  const coreRunning = endpoint.run(coreController.signal);

  const storage = { getItem: () => null, setItem: () => undefined };
  const device = new DeviceControlAgent({
    deviceId: "test-mac", deviceName: "测试 Mac", platform: "MacIntel", storage,
    invoke: async (command: string) => {
      assert.equal(command, "device_get_info");
      return { platform: "macos", arch: "aarch64", appVersion: "0.0.1", hostname: "test-macbook" };
    },
  });
  const client = new RelayCompanionClient({
    WebSocketImpl: WebSocket,
    clientId: "test-mac",
    onReady: ({ send }: { send: (payload: Record<string, unknown>) => Promise<void> }) => device.attach(send),
    onEvent: (event: Record<string, unknown>) => { void device.handle(event); },
  });
  setTimeout(() => client.connect({ mode: "relay", url: `ws://127.0.0.1:${port}`, token: pairingCode, name: "测试 Mac" }), 40);
  for (let attempt = 0; attempt < 100 && devices.list().length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(devices.list()[0]?.name, "测试 Mac");
  assert.deepEqual(await devices.execute("测试 Mac", "device.info", {}, 1000), {
    platform: "macos", arch: "aarch64", appVersion: "0.0.1", hostname: "test-macbook",
  });

  client.disconnect();
  coreController.abort();
  await coreRunning;
  relayController.abort();
  await relayRunning;
});

test("Mac file bytes reach the Core file-send handler through the encrypted relay", async () => {
  const relayController = new AbortController();
  const relay = new CompanionRelayServer({ port: 0 });
  const relayRunning = relay.run(relayController.signal);
  for (let attempt = 0; attempt < 50 && !relay.address(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const port = relay.address()?.port;
  assert.ok(port);

  const pairingCode = createPairingCode("file-send-core");
  const devices = new DeviceControlRouter();
  const coreController = new AbortController();
  const endpoint = new RelayCompanionEndpoint({
    url: `ws://127.0.0.1:${port}`,
    pairingCode,
    serverName: "Test Core",
  }, async () => ({ chunks: [], emotion: "neutral", intensity: 0, motion: "Idle" }), devices, async (request) => {
    const output = await devices.execute(request.clientId, "files.read_binary", { path: request.path }, 2000) as Record<string, unknown>;
    assert.equal(output.name, "hello.txt");
    assert.equal(Buffer.from(String(output.data), "base64").toString(), "hello from mac");
    return { name: "hello.txt", size: 14, sha256: "test-hash", externalId: "qq-file-1" };
  });
  const coreRunning = endpoint.run(coreController.signal);

  const values = new Map<string, string>();
  values.set("emilia.device.permissions.v1", JSON.stringify({ "files.read_binary": true }));
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  const device = new DeviceControlAgent({
    deviceId: "file-mac", deviceName: "文件 Mac", platform: "MacIntel", storage,
    invoke: async (command: string) => command === "device_get_info"
      ? { platform: "macos", arch: "aarch64", appVersion: "0.0.1", hostname: "file-mac" }
      : { path: "/allowed/hello.txt", name: "hello.txt", mediaType: "application/octet-stream", size: 14, data: Buffer.from("hello from mac").toString("base64") },
  });
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for QQ file result")), 5000);
    const client = new RelayCompanionClient({
      WebSocketImpl: WebSocket,
      clientId: "file-mac",
      onReady: ({ send }: { send: (payload: Record<string, unknown>) => Promise<void> }) => device.attach(send),
      onEvent(event: Record<string, unknown>) {
        if (event.type === "device.command") return void device.handle(event);
        if (event.type === "device.announce.ack") client.sendFileToQq("/allowed/hello.txt", "request-file-send");
        if (event.type === "file.send_qq.result") {
          clearTimeout(timer);
          client.disconnect();
          resolve(event);
        }
      },
    });
    setTimeout(() => client.connect({ mode: "relay", url: `ws://127.0.0.1:${port}`, token: pairingCode, name: "文件 Mac" }), 40);
  });

  assert.deepEqual(await result, {
    type: "file.send_qq.result", requestId: "request-file-send", ok: true,
    name: "hello.txt", size: 14, sha256: "test-hash", externalId: "qq-file-1",
  });
  coreController.abort();
  await coreRunning;
  relayController.abort();
  await relayRunning;
});

test("desktop lists and completes Core tasks through encrypted relay transport", async () => {
  const relayController = new AbortController();
  const relay = new CompanionRelayServer({ port: 0 });
  const relayRunning = relay.run(relayController.signal);
  for (let attempt = 0; attempt < 50 && !relay.address(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const port = relay.address()?.port;
  assert.ok(port);

  const pairingCode = createPairingCode("task-center-core");
  const coreController = new AbortController();
  let pending = [{ id: "task-123", title: "整理报告", notes: null, status: "pending", priority: "high", dueAt: 2000, createdAt: 1000, updatedAt: 1000 }];
  const endpoint = new RelayCompanionEndpoint({
    url: `ws://127.0.0.1:${port}`, pairingCode, serverName: "Test Core",
  }, async () => ({ chunks: [], emotion: "neutral", intensity: 0, motion: "Idle" }), null, null, async (request) => {
    if (request.action === "complete") pending = [];
    return { tasks: pending };
  });
  const coreRunning = endpoint.run(coreController.signal);

  const responses: Array<Record<string, unknown>> = [];
  const completed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for task results")), 5000);
    let requested = false;
    const client = new RelayCompanionClient({
      WebSocketImpl: WebSocket,
      clientId: "task-mac",
      onState(event) {
        if (event.state === "online" && !requested) {
          requested = true;
          client.sendTaskCommand("list", "", "tasks-list");
        }
      },
      onEvent(event) {
        if (event.type !== "tasks.result") return;
        responses.push(event);
        if (event.requestId === "tasks-list") client.sendTaskCommand("complete", "task-123", "tasks-complete");
        else {
          clearTimeout(timer);
          client.disconnect();
          resolve();
        }
      },
    });
    setTimeout(() => client.connect({ mode: "relay", url: `ws://127.0.0.1:${port}`, token: pairingCode, name: "任务 Mac" }), 40);
  });

  await completed;
  assert.equal((responses[0].tasks as unknown[]).length, 1);
  assert.equal((responses[1].tasks as unknown[]).length, 0);
  coreController.abort();
  await coreRunning;
  relayController.abort();
  await relayRunning;
});

test("a Windows Voice Worker returns local audio to a remote Core over encrypted Relay frames", async () => {
  const relayController = new AbortController();
  const relay = new CompanionRelayServer({ port: 0 });
  const relayRunning = relay.run(relayController.signal);
  for (let attempt = 0; attempt < 50 && !relay.address(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const port = relay.address()?.port;
  assert.ok(port);

  const pairingCode = createPairingCode("remote-voice-core");
  const nodes = new RuntimeNodeRegistry();
  const coreController = new AbortController();
  const endpoint = new RelayCompanionEndpoint({
    url: `ws://127.0.0.1:${port}`, pairingCode, serverName: "Remote Mac Core",
  }, async () => ({ chunks: [], emotion: "neutral", intensity: 0, motion: "Idle" }), null, null, null, null, nodes);
  const coreRunning = endpoint.run(coreController.signal);

  const workerController = new AbortController();
  const worker = new RelayVoiceWorker({
    url: `ws://127.0.0.1:${port}`, pairingCode, nodeId: "windows-voice", name: "Windows Voice",
    voiceEndpoint: "http://127.0.0.1:9873", voiceToken: "test-token-with-enough-length",
  }, {
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/synthesize")) {
        return new Response(JSON.stringify({ audioUrl: "/v1/audio/test-audio", contentType: "audio/wav" }), { status: 200 });
      }
      return new Response(Buffer.from("pretend-wav-audio"), { status: 200 });
    },
  });
  const workerRunning = worker.run(workerController.signal);
  for (let attempt = 0; attempt < 100 && !nodes.findByCapability("voice.synthesize"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(nodes.findByCapability("voice.synthesize")?.id, "windows-voice");

  const voice = await endpoint.synthesizeIfJapanese("おはよう", "happy");
  assert.equal(voice?.mimeType, "audio/wav");
  assert.equal(Buffer.from(voice?.bytes ?? []).toString(), "pretend-wav-audio");

  workerController.abort();
  await workerRunning;
  coreController.abort();
  await coreRunning;
  relayController.abort();
  await relayRunning;
});

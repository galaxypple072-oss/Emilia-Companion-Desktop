import { CompanionBridgeClient, testBridgeConnection, validateBridgeConfig } from "./bridge-client.js";
import { RelayCompanionClient, testRelayConnection, validateRelayConfig } from "./relay-client.js";

export function validateConnectionConfig(config) {
  return config?.mode === "relay" ? validateRelayConfig(config) : Object.freeze({ mode: "direct", ...validateBridgeConfig(config) });
}

export function connectionConfigFingerprint(config) {
  const normalized = validateConnectionConfig(config);
  return `${normalized.mode}\n${normalized.url}\n${normalized.token}\n${normalized.name}`;
}

export function testConnection(config, options) {
  return config?.mode === "relay" ? testRelayConnection(config, options) : testBridgeConnection(config, options);
}

export class CompanionConnectionClient {
  constructor(options) {
    this.options = options;
    this.active = null;
  }

  connect(config) {
    this.active?.disconnect();
    const Client = config?.mode === "relay" ? RelayCompanionClient : CompanionBridgeClient;
    this.active = new Client(this.options);
    this.active.connect(config);
  }

  disconnect() {
    this.active?.disconnect();
    this.active = null;
  }

  sendChat(text) {
    if (!this.active) throw new Error("Core 还没有连接好");
    return this.active.sendChat(text);
  }

  sendFileToQq(path, requestId) {
    if (!this.active) throw new Error("Core 还没有连接好");
    return this.active.sendFileToQq(path, requestId);
  }

  sendTaskCommand(action, taskId, requestId) {
    if (!this.active) throw new Error("Core 还没有连接好");
    return this.active.sendTaskCommand(action, taskId, requestId);
  }
}

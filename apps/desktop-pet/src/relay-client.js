import {
  deriveRelayCredentials,
  openRelayPayload,
  parsePairingCode,
  sealRelayPayload,
} from "../../../packages/companion-relay-protocol/src/index.js";

const OPEN = 1;
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 55_000;

export function normalizeRelayUrl(value) {
  let raw = String(value ?? "").trim();
  if (!raw) throw new Error("请填写中继地址");
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(raw)) raw = `wss://${raw}`;
  let endpoint;
  try { endpoint = new URL(raw); } catch { throw new Error("中继地址格式不正确"); }
  if (!["ws:", "wss:"].includes(endpoint.protocol)) throw new Error("中继地址需要使用 wss:// 或 ws://");
  if (endpoint.username || endpoint.password) throw new Error("中继地址不能包含账号或密码");
  endpoint.hash = "";
  return endpoint.toString();
}

export function validateRelayConfig(config) {
  const url = normalizeRelayUrl(config?.url);
  const token = String(config?.token ?? "").trim();
  parsePairingCode(token);
  const name = String(config?.name ?? "").trim().slice(0, 30);
  if (!name) throw new Error("请填写本机名称");
  return Object.freeze({ mode: "relay", url, token, name });
}

export async function testRelayConnection(config, {
  WebSocketImpl = WebSocket,
  clientId = "connection-wizard",
  timeoutMs = 7000,
  now = () => Date.now(),
} = {}) {
  const normalized = validateRelayConfig(config);
  const credentials = await deriveRelayCredentials(normalized.token);
  return new Promise((resolve, reject) => {
    const startedAt = now();
    const socket = new WebSocketImpl(normalized.url);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* best effort */ }
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("连接超时，请检查中继地址和 Core 是否在线")), timeoutMs);
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      type: "relay.auth", role: "client", deviceId: credentials.deviceId,
      peerId: clientId, authToken: credentials.authToken,
    })));
    socket.addEventListener("message", (message) => {
      let event;
      try { event = JSON.parse(String(message.data)); } catch { return; }
      if (event.type === "relay.auth.ok") finish(null, {
        ok: true, serverName: "Emilia 私密中继", latencyMs: Math.max(0, now() - startedAt), config: normalized,
      });
      if (event.type === "relay.auth.error") finish(new Error(event.message || "配对码不正确"));
    });
    socket.addEventListener("error", () => finish(new Error("无法连接中继，请检查网络和地址")));
    socket.addEventListener("close", () => finish(new Error("中继在验证完成前断开了连接")));
  });
}

export class RelayCompanionClient {
  constructor({ WebSocketImpl = WebSocket, clientId, onState = () => {}, onEvent = () => {}, onReady = () => {} }) {
    this.WebSocketImpl = WebSocketImpl;
    this.clientId = clientId;
    this.onState = onState;
    this.onEvent = onEvent;
    this.onReady = onReady;
    this.socket = null;
    this.config = null;
    this.credentials = null;
    this.authenticated = false;
    this.intentionalClose = false;
    this.retryTimer = 0;
    this.retryCount = 0;
    this.generation = 0;
    this.seenMessageIds = new Set();
    // Web Crypto decryption is asynchronous. Keep relay frames ordered so an
    // audio.end frame can never overtake an earlier audio.chunk frame.
    this.receiveChain = Promise.resolve();
    this.heartbeatTimer = 0;
    this.lastPongAt = 0;
  }

  connect(config) {
    this.config = validateRelayConfig(config);
    this.disconnect(false);
    this.intentionalClose = false;
    const generation = ++this.generation;
    this.onState({ state: "connecting", label: "连接中", transport: "relay", transient: true });
    deriveRelayCredentials(this.config.token).then((credentials) => {
      if (generation !== this.generation || this.intentionalClose) return;
      this.credentials = credentials;
      this.open();
    }).catch((error) => this.onState({ state: "error", label: "配对码错误", message: error.message, transport: "relay" }));
  }

  disconnect(intentional = true) {
    this.intentionalClose = intentional;
    this.generation += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    this.stopHeartbeat();
    this.authenticated = false;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    if (intentional) this.onState({ state: "offline", label: "离线", transport: "relay", transient: true });
  }

  sendChat(text) {
    const normalized = String(text ?? "").trim();
    if (!normalized) throw new Error("消息不能为空");
    if (!this.socket || this.socket.readyState !== OPEN || !this.authenticated || !this.credentials) throw new Error("Core 还没有连接好");
    const requestId = crypto.randomUUID();
    void this.sendEncrypted({ type: "chat.send", requestId, text: normalized, clientName: this.config.name });
    return requestId;
  }

  sendFileToQq(path, requestId = crypto.randomUUID()) {
    const normalized = String(path ?? "").trim();
    if (!normalized) throw new Error("请选择要发送的文件");
    if (!this.socket || this.socket.readyState !== OPEN || !this.authenticated || !this.credentials) throw new Error("Core 还没有连接好");
    void this.sendEncrypted({ type: "file.send_qq", requestId, path: normalized, clientName: this.config.name });
    return requestId;
  }

  sendTaskCommand(action, taskId, requestId = crypto.randomUUID()) {
    if (!this.socket || this.socket.readyState !== OPEN || !this.authenticated || !this.credentials) throw new Error("Core 还没有连接好");
    if (!["list", "complete", "cancel"].includes(action)) throw new Error("不支持的任务操作");
    void this.sendEncrypted({ type: `tasks.${action}`, requestId, ...(taskId ? { taskId } : {}) });
    return requestId;
  }

  open() {
    if (!this.config || !this.credentials || this.intentionalClose) return;
    this.onState({ state: "connecting", label: "连接中", transport: "relay", transient: true });
    const socket = new this.WebSocketImpl(this.config.url);
    this.socket = socket;
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      type: "relay.auth", role: "client", deviceId: this.credentials.deviceId,
      peerId: this.clientId, authToken: this.credentials.authToken,
    })));
    socket.addEventListener("message", (message) => {
      this.receiveChain = this.receiveChain
        .then(() => this.receive(socket, message))
        .catch((error) => this.onState({
          state: "error",
          label: "数据验证失败",
          message: error instanceof Error ? error.message : "收到的加密消息无法处理",
          transport: "relay",
        }));
    });
    socket.addEventListener("close", () => {
      if (socket !== this.socket) return;
      this.stopHeartbeat();
      this.socket = null;
      this.authenticated = false;
      if (this.intentionalClose) return;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(5, this.retryCount++));
      this.onState({ state: "offline", label: "已断开", message: `${Math.ceil(wait / 1000)} 秒后自动重连`, retryInMs: wait, transport: "relay", transient: true });
      this.retryTimer = setTimeout(() => this.open(), wait);
    });
    socket.addEventListener("error", () => this.onState({ state: "error", label: "连接失败", message: "正在尝试自动恢复", transport: "relay", transient: true }));
  }

  async receive(socket, message) {
    let event;
    try { event = JSON.parse(String(message.data)); } catch { return; }
    if (event.type === "relay.auth.ok") {
      if (socket !== this.socket) return;
      this.authenticated = true;
      this.retryCount = 0;
      this.startHeartbeat(socket);
      this.onState({ state: "online", label: "在线", serverName: "Emilia 私密中继", transport: "relay", transient: true });
      void this.onReady({ send: (payload) => this.sendEncrypted(payload) });
      return;
    }
    if (event.type === "relay.auth.error") {
      if (event.message === "Core is not registered") {
        // At logon the desktop can reach the relay before Windows Core has
        // completed its own relay authentication. This is recoverable, not a
        // bad pairing code: let the normal close handler retry with backoff.
        this.onState({ state: "offline", label: "正在等待 Core", message: "Windows Core 正在启动，稍后自动重连", transport: "relay", transient: true });
        socket.close(4004, "Core is not registered");
        return;
      }
      this.intentionalClose = true;
      this.onState({ state: "error", label: "配对失败", message: event.message, transport: "relay" });
      return;
    }
    if (event.type === "relay.pong") {
      this.lastPongAt = Date.now();
      return;
    }
    if (event.type === "relay.peer_offline") {
      this.onState({ state: "offline", label: "Core 离线", message: "Windows Core 暂未上线", transport: "relay", transient: true });
      return;
    }
    if (event.type === "relay.peer_online" && event.peerId === "core") {
      this.onState({ state: "online", label: "在线", serverName: "Emilia 私密中继", transport: "relay", transient: true });
      void this.onReady({ send: (payload) => this.sendEncrypted(payload) });
      return;
    }
    if (event.type !== "relay.frame" || event.senderId !== "core" || !this.credentials) return;
    if (this.seenMessageIds.has(event.messageId)) return;
    this.seenMessageIds.add(event.messageId);
    if (this.seenMessageIds.size > 2048) this.seenMessageIds.delete(this.seenMessageIds.values().next().value);
    try {
      const payload = await openRelayPayload(this.credentials, event);
      if (payload.type === "device.announce.ack") {
        this.onState({ state: "online", label: "在线", serverName: "Emilia 私密中继", transport: "relay", transient: true });
      }
      this.onEvent(payload);
    } catch {
      this.onState({ state: "error", label: "数据验证失败", message: "收到的加密消息无法验证", transport: "relay" });
    }
  }

  async sendEncrypted(payload) {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || !this.credentials) return;
    const frame = await sealRelayPayload(this.credentials, {
      senderId: this.clientId, recipientId: "core", payload,
    });
    if (socket === this.socket && socket.readyState === OPEN) socket.send(JSON.stringify(frame));
  }

  startHeartbeat(socket) {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (socket !== this.socket || socket.readyState !== OPEN || !this.authenticated) return;
      if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        this.onState({ state: "offline", label: "连接超时", message: "正在自动重连中继", transport: "relay", transient: true });
        socket.close(4008, "Heartbeat timeout");
        return;
      }
      socket.send(JSON.stringify({ type: "relay.ping", at: Date.now() }));
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = 0;
  }
}

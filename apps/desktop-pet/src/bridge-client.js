const OPEN = 1;
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 55_000;

export function normalizeBridgeUrl(value) {
  let raw = String(value ?? "").trim();
  if (!raw) throw new Error("请填写 Core 地址");
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(raw)) raw = `ws://${raw}`;
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("Core 地址格式不正确");
  }
  if (!["ws:", "wss:"].includes(endpoint.protocol)) throw new Error("Core 地址需要使用 ws:// 或 wss://");
  if (endpoint.username || endpoint.password) throw new Error("Core 地址不能包含账号或密码");
  if (!endpoint.hostname) throw new Error("Core 地址缺少主机名或 IP");
  if (!endpoint.port) endpoint.port = "8765";
  endpoint.pathname = "/";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString();
}

export function validateBridgeConfig(config) {
  const url = normalizeBridgeUrl(config?.url);
  const token = String(config?.token ?? "").trim();
  const name = String(config?.name ?? "").trim().slice(0, 30);
  if (token.length < 24) throw new Error("访问 Token 至少需要 24 个字符");
  if (!name) throw new Error("请填写本机名称");
  return Object.freeze({ url, token, name });
}

export function bridgeConfigFingerprint(config) {
  const normalized = validateBridgeConfig(config);
  return `${normalized.url}\n${normalized.token}\n${normalized.name}`;
}

export function testBridgeConnection(config, {
  WebSocketImpl = WebSocket,
  clientId = "connection-wizard",
  platform = globalThis.navigator?.platform || "desktop",
  timeoutMs = 7000,
  now = () => Date.now(),
} = {}) {
  const normalized = validateBridgeConfig(config);
  return new Promise((resolve, reject) => {
    const startedAt = now();
    let settled = false;
    let serverName = "Emilia Core";
    const socket = new WebSocketImpl(normalized.url);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* best effort */ }
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("连接超时，请检查 Core 是否运行以及防火墙设置")), timeoutMs);
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      type: "auth",
      token: normalized.token,
      client: { id: clientId, name: normalized.name, platform },
    })));
    socket.addEventListener("message", (message) => {
      let event;
      try { event = JSON.parse(String(message.data)); } catch { return; }
      if (event.type === "hello" && typeof event.serverName === "string") serverName = event.serverName;
      if (event.type === "auth.ok") finish(null, {
        ok: true,
        serverName: typeof event.serverName === "string" ? event.serverName : serverName,
        latencyMs: Math.max(0, now() - startedAt),
        config: normalized,
      });
      if (event.type === "auth.error") finish(new Error(event.message || "访问 Token 不正确"));
    });
    socket.addEventListener("error", () => finish(new Error("无法连接 Core，请检查地址、网络和防火墙")));
    socket.addEventListener("close", () => finish(new Error("Core 在验证完成前断开了连接")));
  });
}

export class CompanionBridgeClient {
  constructor({ WebSocketImpl = WebSocket, clientId, onState = () => {}, onEvent = () => {}, onReady = () => {} }) {
    this.WebSocketImpl = WebSocketImpl;
    this.clientId = clientId;
    this.onState = onState;
    this.onEvent = onEvent;
    this.onReady = onReady;
    this.socket = null;
    this.config = null;
    this.authenticated = false;
    this.intentionalClose = false;
    this.retryTimer = 0;
    this.retryCount = 0;
    this.heartbeatTimer = 0;
    this.lastPongAt = 0;
  }

  connect(config) {
    this.config = validateBridgeConfig(config);
    this.disconnect(false);
    this.intentionalClose = false;
    this.open();
  }

  disconnect(intentional = true) {
    this.intentionalClose = intentional;
    clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    this.stopHeartbeat();
    this.authenticated = false;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    if (intentional) this.onState({ state: "offline", label: "离线", transport: "direct", transient: true });
  }

  sendChat(text) {
    const normalized = String(text ?? "").trim();
    if (!normalized) throw new Error("消息不能为空");
    if (!this.socket || this.socket.readyState !== OPEN || !this.authenticated) throw new Error("Core 还没有连接好");
    const requestId = crypto.randomUUID();
    this.send({ type: "chat.send", requestId, text: normalized });
    return requestId;
  }

  sendFileToQq(path, requestId = crypto.randomUUID()) {
    const normalized = String(path ?? "").trim();
    if (!normalized) throw new Error("请选择要发送的文件");
    if (!this.socket || this.socket.readyState !== OPEN || !this.authenticated) throw new Error("Core 还没有连接好");
    this.send({ type: "file.send_qq", requestId, path: normalized });
    return requestId;
  }

  sendTaskCommand(action, taskId, requestId = crypto.randomUUID()) {
    if (!this.socket || this.socket.readyState !== OPEN || !this.authenticated) throw new Error("Core 还没有连接好");
    if (!["list", "complete", "cancel"].includes(action)) throw new Error("不支持的任务操作");
    this.send({ type: `tasks.${action}`, requestId, ...(taskId ? { taskId } : {}) });
    return requestId;
  }

  open() {
    if (!this.config || this.intentionalClose) return;
    this.onState({ state: "connecting", label: "连接中", transport: "direct", transient: true });
    const socket = new this.WebSocketImpl(this.config.url);
    this.socket = socket;
    socket.addEventListener("open", () => this.send({
      type: "auth",
      token: this.config.token,
      client: { id: this.clientId, name: this.config.name, platform: navigator.platform || "desktop" },
    }));
    socket.addEventListener("message", (message) => {
      let event;
      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (event.type === "auth.ok") {
        this.authenticated = true;
        this.retryCount = 0;
        this.startHeartbeat(socket);
        this.onState({ state: "online", label: "在线", serverName: event.serverName, transport: "direct", transient: true });
        void this.onReady({ send: async (payload) => this.send(payload) });
      } else if (event.type === "auth.error") {
        this.intentionalClose = true;
        this.onState({ state: "error", label: "Token 错误", message: event.message, transport: "direct" });
      }
      if (event.type === "pong") this.lastPongAt = Date.now();
      this.onEvent(event);
    });
    socket.addEventListener("close", () => {
      if (socket !== this.socket) return;
      this.stopHeartbeat();
      this.socket = null;
      this.authenticated = false;
      if (this.intentionalClose) return;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(5, this.retryCount++));
      this.onState({ state: "offline", label: "已断开", message: `${Math.ceil(wait / 1000)} 秒后自动重连`, retryInMs: wait, transport: "direct", transient: true });
      this.retryTimer = setTimeout(() => this.open(), wait);
    });
    socket.addEventListener("error", () => this.onState({ state: "error", label: "连接失败", message: "正在尝试自动恢复", transport: "direct", transient: true }));
  }

  send(event) {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(event));
  }

  startHeartbeat(socket) {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (socket !== this.socket || socket.readyState !== OPEN || !this.authenticated) return;
      if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        this.onState({ state: "offline", label: "连接超时", message: "正在自动重连 Core", transport: "direct", transient: true });
        socket.close(4008, "Heartbeat timeout");
        return;
      }
      this.send({ type: "ping", at: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = 0;
  }
}

import {
  DEVICE_CAPABILITY_IDS,
  DEVICE_CONTROL_PROTOCOL,
  createDeviceResultMessages,
  normalizeDeviceCommand,
} from "../../../packages/companion-relay-protocol/src/device-control.js";

export const DEVICE_PERMISSION_KEY = "emilia.device.permissions.v1";
export const DEVICE_AUDIT_KEY = "emilia.device.audit.v1";

export const DEVICE_CAPABILITIES = Object.freeze([
  { id: "device.info", label: "设备基本信息", detail: "系统、架构和客户端版本", locked: true },
  { id: "notification.show", label: "显示系统通知", detail: "让艾米莉亚在本机提醒你" },
  { id: "url.open", label: "打开网页", detail: "仅允许 http 与 https 地址" },
  { id: "clipboard.write", label: "写入剪贴板", detail: "把文字复制到本机剪贴板" },
  { id: "clipboard.read", label: "读取剪贴板", detail: "可能包含敏感内容，默认关闭" },
  { id: "files.roots", label: "查看授权目录", detail: "只能看到你手动选择的目录" },
  { id: "files.list", label: "浏览本机文件", detail: "列出授权目录内的文件，不会修改" },
  { id: "files.search", label: "搜索本机文件", detail: "仅在授权目录内按名称搜索" },
  { id: "files.read_text", label: "读取文本文件", detail: "读取授权目录内的文本和代码" },
  { id: "files.read_document", label: "解析本机文档", detail: "文档会端到端加密传给你的 Core 解析" },
  { id: "files.read_binary", label: "发送本机文件", detail: "仅在你主动发送时，将选中文件端到端加密传给 Core，默认关闭" },
  { id: "screen.capture", label: "读取屏幕画面", detail: "截图会端到端加密传给视觉模型，默认关闭" },
]);

const capabilityIds = new Set(DEVICE_CAPABILITY_IDS);

export function loadDevicePermissions(storage = localStorage) {
  let saved = {};
  try { saved = JSON.parse(storage.getItem(DEVICE_PERMISSION_KEY) || "{}"); } catch { /* use secure defaults */ }
  return Object.freeze(Object.fromEntries(DEVICE_CAPABILITIES.map((capability) => [
    capability.id,
    capability.locked || saved?.[capability.id] === true,
  ])));
}

export function saveDevicePermissions(permissions, storage = localStorage) {
  const normalized = Object.fromEntries(DEVICE_CAPABILITIES.map((capability) => [
    capability.id,
    capability.locked || permissions?.[capability.id] === true,
  ]));
  storage.setItem(DEVICE_PERMISSION_KEY, JSON.stringify(normalized));
  return Object.freeze(normalized);
}

export function loadDeviceAudit(storage = localStorage) {
  try {
    const value = JSON.parse(storage.getItem(DEVICE_AUDIT_KEY) || "[]");
    return Array.isArray(value) ? value.slice(-20) : [];
  } catch { return []; }
}

function textInput(input, key, maxLength, label) {
  const value = String(input?.[key] ?? "").trim();
  if (!value || value.length > maxLength) throw new Error(`${label}格式不正确`);
  return value;
}

function normalizeHttpUrl(input) {
  const raw = textInput(input, "url", 2048, "网页地址");
  let url;
  try { url = new URL(raw); } catch { throw new Error("网页地址格式不正确"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("只允许打开 http 或 https 网页");
  }
  return url.toString();
}

export class DeviceControlAgent {
  constructor({ deviceId, deviceName, invoke, platform = navigator.platform, storage = localStorage, onAudit = () => {} }) {
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.invoke = invoke;
    this.platform = platform;
    this.storage = storage;
    this.onAudit = onAudit;
    this.send = null;
    this.heartbeatTimer = 0;
  }

  async attach(send) {
    this.send = send;
    if (this.heartbeatTimer && globalThis.window) window.clearInterval(this.heartbeatTimer);
    await this.announce();
    if (globalThis.window) {
      this.heartbeatTimer = window.setInterval(() => { void this.announce(); }, 60_000);
    }
  }

  async announce() {
    if (!this.send) return;
    let info = { platform: this.platform || "desktop", arch: "unknown", appVersion: "web" };
    try { info = await this.invoke("device_get_info"); } catch { /* browser preview */ }
    const permissions = loadDevicePermissions(this.storage);
    await this.send({
      type: "device.announce",
      protocol: DEVICE_CONTROL_PROTOCOL,
      device: {
        id: this.deviceId,
        name: this.deviceName,
        platform: info.platform || this.platform || "desktop",
        arch: info.arch || "unknown",
        appVersion: info.appVersion || "unknown",
      },
      capabilities: DEVICE_CAPABILITIES.map(({ id }) => ({ id, granted: permissions[id] === true })),
    });
  }

  async handle(payload) {
    let command;
    try { command = normalizeDeviceCommand(payload); } catch { return false; }
    const result = { type: "device.result", protocol: DEVICE_CONTROL_PROTOCOL, requestId: command.requestId };
    try {
      const permissions = loadDevicePermissions(this.storage);
      if (!capabilityIds.has(command.capability) || permissions[command.capability] !== true) {
        throw new Error("这项设备能力尚未在本机授权");
      }
      result.output = await this.execute(command.capability, command.input);
      result.ok = true;
    } catch (error) {
      result.ok = false;
      result.error = error instanceof Error ? error.message : String(error);
    }
    const audit = [...loadDeviceAudit(this.storage), {
      at: Date.now(), capability: command.capability, ok: result.ok, error: result.ok ? "" : result.error,
    }].slice(-20);
    this.storage.setItem(DEVICE_AUDIT_KEY, JSON.stringify(audit));
    this.onAudit(audit);
    const messages = createDeviceResultMessages(command.requestId, result.ok
      ? { ok: true, output: result.output }
      : { ok: false, error: result.error });
    for (const message of messages) await this.send?.(message);
    return true;
  }

  async execute(capability, input) {
    if (capability === "device.info") return this.invoke("device_get_info");
    if (capability === "clipboard.read") {
      const text = await this.invoke("device_read_clipboard");
      return { text: String(text ?? "").slice(0, 20_000) };
    }
    if (capability === "clipboard.write") {
      const text = textInput(input, "text", 20_000, "剪贴板文字");
      await this.invoke("device_write_clipboard", { text });
      return { written: true, characters: text.length };
    }
    if (capability === "url.open") {
      const url = normalizeHttpUrl(input);
      await this.invoke("device_open_url", { url });
      return { opened: true, url };
    }
    if (capability === "notification.show") {
      const title = textInput(input, "title", 80, "通知标题");
      const body = textInput(input, "body", 500, "通知内容");
      await this.invoke("device_show_notification", { title, body });
      return { shown: true };
    }
    if (capability === "files.roots") return this.invoke("device_get_file_roots");
    if (capability === "files.list") {
      const path = textInput(input, "path", 2000, "目录路径");
      return this.invoke("device_list_directory", { path });
    }
    if (capability === "files.search") {
      const query = textInput(input, "query", 200, "搜索词");
      const root = String(input?.root ?? "").trim().slice(0, 2000);
      const maxResults = Math.max(1, Math.min(100, Number(input?.maxResults) || 50));
      return this.invoke("device_search_files", { root, query, maxResults });
    }
    if (capability === "files.read_text") {
      const path = textInput(input, "path", 2000, "文件路径");
      const maxChars = Math.max(1000, Math.min(50_000, Number(input?.maxChars) || 30_000));
      return this.invoke("device_read_text_file", { path, maxChars });
    }
    if (capability === "files.read_document") {
      const path = textInput(input, "path", 2000, "文件路径");
      return this.invoke("device_read_document", { path });
    }
    if (capability === "files.read_binary") {
      const path = textInput(input, "path", 2000, "文件路径");
      return this.invoke("device_read_binary_file", { path });
    }
    if (capability === "screen.capture") return this.invoke("device_capture_screen");
    throw new Error("不支持的设备能力");
  }
}

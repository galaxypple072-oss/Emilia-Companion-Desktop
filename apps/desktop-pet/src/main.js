import "./startup-diagnostics.js";
import { connectionConfigFingerprint, testConnection, validateConnectionConfig } from "./connection-client.js";
import { defaultClientName } from "./connection-profile.js";
import { DEVICE_CAPABILITIES, loadDeviceAudit, loadDevicePermissions, saveDevicePermissions } from "./device-control.js";
import { loadEmiliaWardrobe, loadSavedOutfit } from "./emilia-wardrobe.js";
import { savePersistentConnectionProfile } from "./persistent-connection-profile.js";
import { parseConnectionCode } from "../../../packages/companion-relay-protocol/src/index.js";

const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke ?? (async () => { throw new Error("设备能力只在桌面客户端中可用"); });
const listen = tauri?.event?.listen;
const emit = tauri?.event?.emit;
const HISTORY_KEY = "emilia.chat.history.v1";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const requestedPage = new URLSearchParams(window.location.search).get("page");
let currentPage = ["chat", "tasks", "files", "devices", "core", "memory", "proactive", "appearance", "settings"].includes(requestedPage) ? requestedPage : "chat";
let currentConnection = { state: "offline", label: "离线", serverName: "", transport: "", retryInMs: 0, updatedAt: 0 };
let currentOutfitId = "";
let pendingChatRequest = "";
let pendingChatClearsComposer = false;
let pendingChatTimer = 0;

const runtimeLocation = `${window.location.protocol}//${window.location.host}${window.location.pathname}`;
const coreUiRuntime = $("#core-ui-runtime");
if (coreUiRuntime) coreUiRuntime.textContent = `UI build: 2026-09-06-b · ${runtimeLocation}`;
void invoke("frontend_report_error", { message: `[diagnostic] UI build=2026-09-06-b runtime=${runtimeLocation}` }).catch(() => {});

function navigate(page) {
  if (!document.querySelector(`[data-page-panel="${CSS.escape(page)}"]`)) return;
  currentPage = page;
  for (const panel of $$(`[data-page-panel]`)) panel.classList.toggle("active", panel.dataset.pagePanel === page);
  for (const button of $$(`[data-page]`)) button.classList.toggle("active", button.dataset.page === page);
  if (page === "chat") window.setTimeout(() => $("#main-chat-input")?.focus(), 80);
  if (page === "tasks") void requestTasks("list");
  if (page === "core") {
    void refreshCoreService();
    void refreshCoreLog();
    void refreshVoiceService();
    void refreshVoiceLog();
    void refreshPairedDevices();
  }
  if (page === "settings") { void refreshAgentSetup(); void refreshRelaySetup(); }
}

for (const button of $$(`[data-page]`)) button.addEventListener("click", () => navigate(button.dataset.page));
for (const button of $$(`[data-open-page]`)) button.addEventListener("click", () => navigate(button.dataset.openPage));
$("#main-show-portrait").addEventListener("click", async () => {
  try { await invoke("set_pet_portrait_hidden", { hidden: false }); }
  catch (error) { console.warn("[desktop] failed to show portrait", error); }
});
$("#main-quit-app").addEventListener("click", () => { void invoke("quit_application"); });

function storedHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function createMessage(item) {
  if (!item || !["user", "assistant", "system"].includes(item.role) || typeof item.text !== "string") return null;
  const message = document.createElement("p");
  message.className = `main-message ${item.role}`;
  message.textContent = item.text;
  message.dataset.chatKey = `${item.at || 0}:${item.role}:${item.text}`;
  return message;
}

function renderHistory(history) {
  const container = $("#main-chat-messages");
  container.replaceChildren();
  const items = history.slice(-80).map(createMessage).filter(Boolean);
  if (!items.length) {
    const empty = document.createElement("div");
    empty.id = "chat-empty";
    empty.className = "empty-state";
    empty.innerHTML = '<span class="empty-orb">E</span><strong>我在这里</strong><small>从桌宠的快捷输入或这里开始聊天</small>';
    container.append(empty);
  } else {
    container.append(...items);
  }
  container.scrollTop = container.scrollHeight;
}

function appendMessage(item) {
  const message = createMessage(item);
  if (!message) return;
  const container = $("#main-chat-messages");
  if ($(`[data-chat-key="${CSS.escape(message.dataset.chatKey)}"]`)) return;
  $("#chat-empty")?.remove();
  container.append(message);
  container.scrollTop = container.scrollHeight;
}

renderHistory(storedHistory());

function updateConnection(state = {}) {
  currentConnection = { ...currentConnection, ...state, updatedAt: Date.now() };
  const normalized = ["online", "connecting", "error"].includes(currentConnection.state) ? currentConnection.state : "offline";
  const online = normalized === "online";
  $("#sidebar-status-dot").dataset.state = normalized;
  $("#settings-status-dot").dataset.state = normalized;
  $("#sidebar-status").textContent = online ? `${currentConnection.serverName || "Emilia Core"} 在线` : (currentConnection.label || "Core 离线");
  $("#chat-core-pill").dataset.state = normalized;
  $("#chat-core-pill strong").textContent = online ? "Core 在线" : (currentConnection.label || "未连接");
  $("#main-connection-detail").textContent = online
    ? `已连接到 ${currentConnection.serverName || "Emilia Core"}`
    : "尚未连接，可粘贴 Windows 端生成的完整连接码";
  renderConnectionHealth();
}

function renderConnectionHealth() {
  const badge = $("#core-health-badge");
  if (!badge) return;
  const normalized = ["online", "connecting", "error"].includes(currentConnection.state) ? currentConnection.state : "offline";
  const online = normalized === "online";
  badge.dataset.state = normalized;
  badge.textContent = online ? "健康" : (normalized === "connecting" ? "恢复中" : "待恢复");
  $("#core-health-transport").textContent = currentConnection.transport === "relay" ? "私密中继" : (currentConnection.transport === "direct" ? "局域网直连" : "未连接");
  $("#core-health-recovery").textContent = online ? "已守护" : (currentConnection.retryInMs ? `${Math.ceil(currentConnection.retryInMs / 1000)} 秒后重试` : "等待连接");
  $("#core-health-updated").textContent = currentConnection.updatedAt ? new Date(currentConnection.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
  $("#core-health-detail").textContent = online
    ? `与 ${currentConnection.serverName || "Emilia Core"} 的连接正在由心跳守护`
    : (currentConnection.message || "中断后会自动尝试恢复，无需重新配对");
  const result = $("#core-health-result");
  result.dataset.state = normalized === "error" ? "error" : (online ? "success" : "idle");
  result.textContent = online ? "每 20 秒校验一次连接；超时后自动重连" : (currentConnection.message || "连接异常时会自动指数退避重连");
}

function emotionLabel(emotion) {
  return ({ happy: "开心", concerned: "有点担心", think: "思考中", surprise: "惊讶", shy: "害羞", angry: "有点生气", sad: "低落", neutral: "平静" })[emotion] || "平静";
}

function applySnapshot(snapshot = {}) {
  if (Array.isArray(snapshot.history)) renderHistory(snapshot.history);
  if (snapshot.connection) updateConnection(snapshot.connection);
  if (snapshot.outfitId) selectOutfitCard(snapshot.outfitId);
  if (snapshot.emotion) $("#current-emotion").textContent = emotionLabel(snapshot.emotion);
  $("#main-typing").hidden = snapshot.thinking !== true;
}

function clearPendingChat({ error = "" } = {}) {
  if (!pendingChatRequest) return;
  pendingChatRequest = "";
  pendingChatClearsComposer = false;
  window.clearTimeout(pendingChatTimer);
  pendingChatTimer = 0;
  const input = $("#main-chat-input");
  input.disabled = false;
  $("#main-chat-form button").disabled = false;
  if (error) appendMessage({ role: "system", text: error, at: Date.now() });
}

async function sendMainChat(text, { clearComposer = false } = {}) {
  const normalized = String(text ?? "").trim();
  if (!normalized || !emit || pendingChatRequest) return false;
  const input = $("#main-chat-input");
  pendingChatRequest = crypto.randomUUID();
  pendingChatTimer = window.setTimeout(() => clearPendingChat({
    error: "消息仍未确认；连接可能正在恢复。现在可以重新发送。",
  }), 30_000);
  pendingChatClearsComposer = clearComposer;
  if (clearComposer) {
    input.disabled = true;
    $("#main-chat-form button").disabled = true;
  }
  try {
    await emit("companion:main-chat-send", { text: normalized, requestId: pendingChatRequest });
    return true;
  } catch (error) {
    clearPendingChat({ error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

$("#main-chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#main-chat-input");
  await sendMainChat(input.value, { clearComposer: true });
});

$("#main-chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#main-chat-form").requestSubmit();
  }
});

async function renderDeviceInfo() {
  try {
    const info = await invoke("device_get_info");
    $("#sidebar-device").textContent = `${info.hostname} · ${info.platform}`;
    $("#device-platform-badge").textContent = `${info.platform} · ${info.arch}`;
    $("#device-info-grid").innerHTML = `
      <article class="metric-card"><span>设备名称</span><strong style="font-size:17px">${escapeHtml(info.hostname)}</strong><small>当前 Device Agent</small></article>
      <article class="metric-card"><span>系统</span><strong style="font-size:17px">${escapeHtml(info.platform)}</strong><small>${escapeHtml(info.arch)}</small></article>
      <article class="metric-card"><span>客户端</span><strong style="font-size:17px">${escapeHtml(info.appVersion)}</strong><small>Emilia Companion</small></article>
      <article class="metric-card"><span>连接</span><strong style="font-size:17px" id="device-core-state">${currentConnection.state === "online" ? "在线" : "离线"}</strong><small>与 Core 的状态</small></article>`;
  } catch {
    $("#sidebar-device").textContent = "浏览器预览";
  }
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = String(value ?? "");
  return node.innerHTML;
}

let coreServiceBusy = false;
let coreLanConnectionCode = "";
let coreRelayConnectionCode = "";
let pairedDevicesBusy = false;

function formatPairedDeviceTime(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function renderPairedDevices(devices = []) {
  const list = $("#core-paired-devices-list");
  list.replaceChildren();
  if (!devices.length) {
    const empty = document.createElement("p");
    empty.className = "paired-device-empty";
    empty.textContent = "还没有已配对设备";
    list.append(empty);
    return;
  }
  for (const device of devices) {
    const row = document.createElement("div");
    row.className = "paired-device-row";
    const copy = document.createElement("div");
    copy.className = "paired-device-copy";
    const name = document.createElement("strong");
    name.textContent = String(device.name || "未命名设备");
    const detail = document.createElement("small");
    detail.textContent = `最近连接：${formatPairedDeviceTime(device.lastSeenAt)} · 首次配对：${formatPairedDeviceTime(device.createdAt)}`;
    copy.append(name, detail);
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "secondary-action paired-device-revoke";
    revoke.textContent = "撤销访问";
    revoke.addEventListener("click", () => { void revokePairedDevice(device); });
    row.append(copy, revoke);
    list.append(row);
  }
}

async function refreshPairedDevices() {
  if (pairedDevicesBusy) return;
  const refresh = $("#core-paired-devices-refresh");
  const result = $("#core-paired-devices-result");
  pairedDevicesBusy = true;
  refresh.disabled = true;
  try {
    const response = await invoke("core_list_paired_devices");
    const devices = Array.isArray(response) ? response : [];
    renderPairedDevices(devices);
    result.dataset.state = "idle";
    result.textContent = devices.length ? `共 ${devices.length} 台已配对设备。撤销会在其下次连接时生效。` : "还没有设备兑换过连接码。";
  } catch (error) {
    result.dataset.state = "error";
    result.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    pairedDevicesBusy = false;
    refresh.disabled = false;
  }
}

async function revokePairedDevice(device) {
  if (pairedDevicesBusy) return;
  const name = String(device?.name || "这台设备");
  if (!window.confirm(`确定撤销“${name}”的 Core 访问权限吗？它之后需要重新使用新的连接码配对。`)) return;
  const result = $("#core-paired-devices-result");
  pairedDevicesBusy = true;
  result.dataset.state = "idle";
  result.textContent = `正在撤销“${name}”的访问权限…`;
  try {
    await invoke("core_revoke_paired_device", { id: String(device.id || "") });
    result.dataset.state = "success";
    result.textContent = `已撤销“${name}”的访问权限。`;
    pairedDevicesBusy = false;
    await refreshPairedDevices();
  } catch (error) {
    result.dataset.state = "error";
    result.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    pairedDevicesBusy = false;
  }
}

async function createCoreLanConnectionCode() {
  const create = $("#core-lan-code-create");
  const copy = $("#core-lan-code-copy");
  const result = $("#core-lan-code-result");
  create.disabled = true;
  result.dataset.state = "idle";
  result.textContent = "正在生成局域网连接码…";
  try {
    coreLanConnectionCode = await invoke("core_create_lan_connection_code");
    copy.disabled = false;
    result.dataset.state = "success";
    result.textContent = "已生成。10 分钟内在另一台 Emilia Companion 的连接设置中粘贴；首次成功连接后此码立即失效。";
  } catch (error) {
    result.dataset.state = "error";
    result.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    create.disabled = false;
  }
}

$("#core-lan-code-create").addEventListener("click", () => { void createCoreLanConnectionCode(); });
$("#core-paired-devices-refresh").addEventListener("click", () => { void refreshPairedDevices(); });
$("#core-lan-code-copy").addEventListener("click", async () => {
  const result = $("#core-lan-code-result");
  try {
    await navigator.clipboard.writeText(coreLanConnectionCode);
    result.dataset.state = "success";
    result.textContent = "连接码已复制。它只适用于当前局域网且只能使用一次，请不要发给陌生人。";
  } catch (error) {
    result.dataset.state = "error";
    result.textContent = "无法访问剪贴板，请重新生成后手动复制。";
  }
});

async function refreshAgentSetup() {
  const detail = $("#agent-setup-detail");
  if (!detail) return;
  const badge = $("#agent-setup-badge");
  try {
    const status = await invoke("core_agent_setup_status");
    const configured = status.supported && status.configured;
    badge.dataset.state = configured ? "online" : "offline";
    badge.textContent = configured ? "已配置" : (status.supported ? "未配置" : "远端主机");
    detail.textContent = status.detail || "正在等待配置";
    $("#agent-setup-url").textContent = status.baseUrl || "—";
    $("#agent-setup-model").textContent = status.model || "—";
    if (status.baseUrl) $("#agent-setup-base-url").value = status.baseUrl;
    if (status.model) $("#agent-setup-model-input").value = status.model;
  } catch (error) {
    badge.dataset.state = "error";
    badge.textContent = "检查失败";
    detail.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function refreshRelaySetup() {
  const detail = $("#relay-setup-detail");
  if (!detail) return;
  try {
    const status = await invoke("core_relay_setup_status");
    detail.textContent = status.detail || "尚未启用私有中继。";
    if (status.url) $("#relay-setup-url").value = status.url;
  } catch (error) { detail.textContent = error instanceof Error ? error.message : String(error); }
}

$("#agent-setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#agent-setup-form button");
  const result = $("#agent-setup-result");
  button.disabled = true;
  result.dataset.state = "idle";
  result.textContent = "正在安全保存模型配置并重启 Core…";
  try {
    await invoke("core_configure_agent", { baseUrl: $("#agent-setup-base-url").value, model: $("#agent-setup-model-input").value, apiKey: $("#agent-setup-key").value });
    $("#agent-setup-key").value = "";
    result.dataset.state = "success";
    result.textContent = "模型已配置，Core 正在后台重启。无需复制命令或再次粘贴 Key。";
    await refreshAgentSetup();
  } catch (error) {
    result.dataset.state = "error";
    result.textContent = error instanceof Error ? error.message : String(error);
  } finally { button.disabled = false; }
});

$("#relay-setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#relay-setup-form button");
  const result = $("#core-relay-code-result");
  button.disabled = true;
  result.dataset.state = "idle";
  result.textContent = "正在保存私有中继并重启 Core…";
  try {
    await invoke("core_configure_relay", { url: $("#relay-setup-url").value, pairingCode: $("#relay-setup-code").value });
    $("#relay-setup-code").value = "";
    result.dataset.state = "success";
    result.textContent = "私有中继已保存，Core 正在后台重启。就绪后点击“生成中继连接码”。";
    await refreshRelaySetup();
  } catch (error) {
    result.dataset.state = "error";
    result.textContent = error instanceof Error ? error.message : String(error);
  } finally { button.disabled = false; }
});

async function createCoreRelayConnectionCode() {
  const create = $("#core-relay-code-create");
  const copy = $("#core-relay-code-copy");
  const result = $("#core-relay-code-result");
  create.disabled = true;
  result.dataset.state = "idle";
  result.textContent = "正在生成私有中继连接码…";
  try {
    coreRelayConnectionCode = await invoke("core_create_relay_connection_code");
    copy.disabled = false;
    result.dataset.state = "success";
    result.textContent = "已生成。把它粘贴到另一台设备的连接设置；中继地址和配对密钥不会单独展示。";
  } catch (error) {
    result.dataset.state = "error";
    result.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    create.disabled = false;
  }
}

$("#core-relay-code-create").addEventListener("click", () => { void createCoreRelayConnectionCode(); });
$("#core-relay-code-copy").addEventListener("click", async () => {
  const result = $("#core-relay-code-result");
  try {
    await navigator.clipboard.writeText(coreRelayConnectionCode);
    result.dataset.state = "success";
    result.textContent = "中继连接码已复制。它可用于你的已配置私有中继；不要发送给陌生人。";
  } catch {
    result.dataset.state = "error";
    result.textContent = "无法访问剪贴板，请重新生成后手动复制。";
  }
});
let voiceServiceBusy = false;

let pendingTaskRequest = "";

function renderTasks(tasks = []) {
  const list = $("#task-list");
  list.replaceChildren();
  $("#task-pending-count").textContent = String(tasks.length);
  $("#active-task-count").textContent = tasks.length ? `${tasks.length} 项待办` : "暂无任务";
  const next = tasks.find((task) => Number.isFinite(task.dueAt));
  $("#task-next-due").textContent = next ? new Date(next.dueAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "无";
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "task-empty";
    empty.textContent = "现在没有待办任务";
    list.append(empty);
    return;
  }
  for (const task of tasks) {
    const item = document.createElement("article");
    item.className = "task-item";
    const due = Number.isFinite(task.dueAt) ? new Date(task.dueAt).toLocaleString("zh-CN", { hour12: false }) : "无截止时间";
    item.innerHTML = `<span class="task-priority" data-priority="${escapeHtml(task.priority)}"></span><span class="task-copy"><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(due)} · ${escapeHtml(task.id.slice(0, 8))}</small></span><span class="task-actions"><button class="secondary-action" data-task-action="cancel" data-task-id="${escapeHtml(task.id)}">取消</button><button class="primary-action" data-task-action="complete" data-task-id="${escapeHtml(task.id)}">完成</button></span>`;
    list.append(item);
  }
}

async function requestTasks(action, taskId = "") {
  if (!emit || pendingTaskRequest) return;
  pendingTaskRequest = crypto.randomUUID();
  $("#task-sync-state").textContent = "同步中";
  $("#task-result").dataset.state = "idle";
  $("#task-result").textContent = action === "list" ? "正在从 Core 读取任务…" : "正在更新任务…";
  try {
    await emit("companion:transport-task-command", { requestId: pendingTaskRequest, action, taskId });
  } catch (error) {
    pendingTaskRequest = "";
    $("#task-sync-state").textContent = "失败";
    $("#task-result").dataset.state = "error";
    $("#task-result").textContent = error instanceof Error ? error.message : String(error);
  }
}

$("#task-refresh").addEventListener("click", () => { void requestTasks("list"); });
$("#task-list").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-task-action]");
  if (button) void requestTasks(button.dataset.taskAction, button.dataset.taskId);
});

function renderCoreService(status = {}) {
  const supported = status.supported === true;
  const running = status.running === true;
  const badge = $("#core-service-badge");
  badge.dataset.state = supported ? (running ? "online" : "offline") : "remote";
  badge.textContent = supported ? (running ? "运行中" : "已停止") : "远端托管";
  $("#core-service-detail").textContent = status.detail || "尚未取得服务状态";
  $("#core-service-process").textContent = running ? `PID ${status.pid || "—"}` : (status.installed ? "未运行" : "未安装");
  $("#core-service-bridge").textContent = status.bridgeListening ? "8765 正常" : "未监听";
  $("#core-service-control-port").textContent = status.controlListening ? "8766 正常" : "未监听";
  if (status.logPath) $("#core-log-path").textContent = status.logPath;
  for (const button of $$('[data-core-action]')) {
    button.disabled = coreServiceBusy || !supported || !status.installed
      || (button.dataset.coreAction === "start" && running)
      || (button.dataset.coreAction === "stop" && !running);
  }
}

async function refreshCoreService() {
  const result = $("#core-service-result");
  try {
    const status = await invoke("core_service_status");
    renderCoreService(status);
    result.dataset.state = status.running ? "success" : "idle";
    result.textContent = status.supported
      ? (status.running ? "Core 后台进程与端口状态已同步" : "Core 当前没有运行")
      : status.detail;
    return status;
  } catch (error) {
    $("#core-service-badge").dataset.state = "error";
    $("#core-service-badge").textContent = "检查失败";
    result.dataset.state = "error";
    result.textContent = error instanceof Error ? error.message : String(error);
    return null;
  }
}

async function controlCoreService(action) {
  if (coreServiceBusy) return;
  coreServiceBusy = true;
  const result = $("#core-service-result");
  for (const button of $$('[data-core-action]')) button.disabled = true;
  result.dataset.state = "idle";
  result.textContent = ({ start: "正在启动 Core…", stop: "正在停止 Core…", restart: "正在重新启动 Core…" })[action] || "正在处理…";
  try {
    const status = await invoke("core_service_control", { action });
    result.dataset.state = "success";
    result.textContent = action === "stop" ? "Core 已停止" : "Core 已启动，连接会自动恢复";
    renderCoreService(status);
    window.setTimeout(() => { void refreshCoreService(); void refreshCoreLog(); }, 1800);
  } catch (error) {
    result.dataset.state = "error";
    result.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    coreServiceBusy = false;
    await refreshCoreService();
  }
}

async function refreshCoreLog() {
  const output = $("#core-log-output");
  try {
    output.textContent = await invoke("core_read_log", { maxLines: 120 });
    output.scrollTop = output.scrollHeight;
  } catch (error) {
    output.textContent = error instanceof Error ? error.message : String(error);
  }
}

for (const button of $$('[data-core-action]')) {
  button.addEventListener("click", () => { void controlCoreService(button.dataset.coreAction); });
}
$("#core-service-refresh").addEventListener("click", () => { void refreshCoreService(); });
$("#core-log-refresh").addEventListener("click", () => { void refreshCoreLog(); });

function renderVoiceService(status = {}) {
  const supported = status.supported === true;
  const running = status.running === true;
  const gradio = status.gradioListening === true;
  const badge = $("#voice-service-badge");
  badge.dataset.state = supported ? (running && gradio ? "online" : (running ? "error" : "offline")) : "remote";
  badge.textContent = supported ? (running && gradio ? "就绪" : (running ? "需检查" : "已停止")) : "远端托管";
  $("#voice-service-detail").textContent = status.detail || "尚未取得语音服务状态";
  $("#voice-service-process").textContent = running ? `PID ${status.pid || "—"}` : (status.installed ? "未运行" : "未安装");
  $("#voice-service-gradio").textContent = gradio ? "9872 正常" : "未监听";
  $("#voice-service-output").textContent = status.lastOutput || "—";
  $("#voice-service-gpt-weight").textContent = status.gptWeight || "—";
  $("#voice-service-sovits-weight").textContent = status.sovitsWeight || "—";
  if (status.logPath) $("#voice-log-path").textContent = `${status.logPath} · 错误日志：${status.errorLogPath || "—"}`;
  for (const button of $$('[data-voice-action]')) button.disabled = voiceServiceBusy || !supported || !status.installed;
}

async function refreshVoiceService() {
  const result = $("#voice-service-result");
  try {
    const status = await invoke("voice_service_status");
    renderVoiceService(status);
    result.dataset.state = status.running && status.gradioListening ? "success" : "idle";
    result.textContent = status.running && status.gradioListening
      ? "本机语音链路已就绪；文本回复会先到，语音随后播放"
      : (status.detail || "语音服务当前不可用");
    return status;
  } catch (error) {
    $("#voice-service-badge").dataset.state = "error";
    $("#voice-service-badge").textContent = "检查失败";
    result.dataset.state = "error";
    result.textContent = error instanceof Error ? error.message : String(error);
    return null;
  }
}

async function controlVoiceService(action) {
  if (voiceServiceBusy) return;
  voiceServiceBusy = true;
  const result = $("#voice-service-result");
  for (const button of $$('[data-voice-action]')) button.disabled = true;
  result.dataset.state = "idle";
  result.textContent = ({ start: "正在启动语音服务…", stop: "正在停止语音服务…", restart: "正在重启语音服务…", boot_stack: "正在启动 GPT-SoVITS 与语音桥接服务…" })[action] || "正在处理…";
  try {
    const status = await invoke("voice_service_control", { action });
    renderVoiceService(status);
    result.dataset.state = status.running ? "success" : "idle";
    result.textContent = action === "stop"
      ? "语音服务已停止"
      : (action === "boot_stack" ? "完整语音栈已请求启动，等待 9872 就绪后可运行诊断" : "语音服务已重启，GPT-SoVITS 保持独立运行");
    window.setTimeout(() => { void refreshVoiceService(); void refreshVoiceLog(); }, 1800);
  } catch (error) {
    result.dataset.state = "error";
    result.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    voiceServiceBusy = false;
    await refreshVoiceService();
  }
}

async function diagnoseVoiceService() {
  if (voiceServiceBusy) return;
  voiceServiceBusy = true;
  const button = $("#voice-service-diagnose");
  const result = $("#voice-service-result");
  button.disabled = true;
  result.dataset.state = "idle";
  result.textContent = "正在请求本机 GPT-SoVITS 生成“おはよう”试听，最多需要两分半钟…";
  try {
    const report = await invoke("voice_service_diagnose");
    const ready = report.synthesis === "成功";
    result.dataset.state = ready ? "success" : "error";
    result.textContent = ready
      ? "诊断成功：已生成日语试听音频，自动语音链路可用"
      : `诊断失败：${report.detail || report.synthesis || "没有返回更多信息"}`;
  } catch (error) {
    result.dataset.state = "error";
    result.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    voiceServiceBusy = false;
    button.disabled = false;
    await refreshVoiceService();
    await refreshVoiceLog();
  }
}

async function refreshVoiceLog() {
  const output = $("#voice-log-output");
  try {
    output.textContent = await invoke("voice_read_log", { maxLines: 80 });
    output.scrollTop = output.scrollHeight;
  } catch (error) {
    output.textContent = error instanceof Error ? error.message : String(error);
  }
}

for (const button of $$('[data-voice-action]')) button.addEventListener("click", () => { void controlVoiceService(button.dataset.voiceAction); });
$("#voice-service-refresh").addEventListener("click", () => { void refreshVoiceService(); });
$("#voice-service-diagnose").addEventListener("click", () => { void diagnoseVoiceService(); });
$("#voice-log-refresh").addEventListener("click", () => { void refreshVoiceLog(); });

function renderPermissions() {
  const permissions = loadDevicePermissions();
  const container = $("#main-device-permissions");
  container.replaceChildren();
  for (const capability of DEVICE_CAPABILITIES) {
    const label = document.createElement("label");
    label.className = "permission-option";
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = capability.label;
    const detail = document.createElement("small");
    detail.textContent = capability.detail;
    copy.append(title, detail);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.capability = capability.id;
    input.checked = permissions[capability.id] === true;
    input.disabled = capability.locked === true;
    label.append(copy, input);
    container.append(label);
  }
  const granted = Object.values(permissions).filter(Boolean).length;
  $("#permission-count").textContent = `${granted}/${DEVICE_CAPABILITIES.length}`;
  $("#device-grant-count").textContent = `${granted} 项已允许`;
}

$("#main-device-permissions").addEventListener("change", async () => {
  const permissions = Object.fromEntries($$("#main-device-permissions input[data-capability]").map((input) => [input.dataset.capability, input.checked]));
  const normalized = saveDevicePermissions(permissions);
  await invoke("device_save_permissions", { permissions: normalized });
  renderPermissions();
  await emit?.("companion:device-permissions-updated");
});

let fileRoots = [];
let activeFileRoot = "";
let currentFilePath = "";
let selectedFileEntry = null;
let filePreviewGeneration = 0;
let pendingFileSendRequest = "";
let pendingFileSendTimer = 0;
const textPreviewExtensions = new Set(["txt", "md", "json", "jsonl", "csv", "tsv", "xml", "yaml", "yml", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "html", "htm", "py", "java", "c", "h", "cpp", "hpp", "rs", "go", "sql", "log", "ini", "toml"]);
const imagePreviewExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

function pathName(path) {
  return String(path ?? "").split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function fileExtension(path) {
  const name = pathName(path);
  return name.includes(".") ? name.split(".").at(-1).toLowerCase() : "";
}

function formatFileSize(size) {
  const value = Number(size);
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function formatModified(value) {
  if (!Number.isFinite(Number(value))) return "—";
  return new Date(Number(value)).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderBreadcrumbs({ search = "" } = {}) {
  const nav = $("#file-breadcrumbs");
  nav.replaceChildren();
  if (!activeFileRoot) {
    nav.textContent = search ? `全部授权位置 / 搜索“${search}”` : "尚未选择位置";
    return;
  }
  const rootButton = document.createElement("button");
  rootButton.type = "button";
  rootButton.textContent = pathName(activeFileRoot);
  rootButton.addEventListener("click", () => { void browseDirectory(activeFileRoot); });
  nav.append(rootButton);
  const windowsPath = /\\/u.test(activeFileRoot);
  const compareCurrent = windowsPath ? currentFilePath.toLowerCase() : currentFilePath;
  const compareRoot = windowsPath ? activeFileRoot.toLowerCase() : activeFileRoot;
  const relative = compareCurrent.startsWith(compareRoot) ? currentFilePath.slice(activeFileRoot.length) : "";
  let cursor = activeFileRoot;
  const separatorCharacter = windowsPath ? "\\" : "/";
  for (const segment of relative.split(/[\\/]/u).filter(Boolean)) {
    const separator = document.createElement("span");
    separator.textContent = "/";
    const button = document.createElement("button");
    cursor = `${cursor.replace(/[\\/]$/u, "")}${separatorCharacter}${segment}`;
    const target = cursor;
    button.type = "button";
    button.textContent = segment;
    button.addEventListener("click", () => { void browseDirectory(target); });
    nav.append(separator, button);
  }
  if (search) {
    const suffix = document.createElement("span");
    suffix.textContent = `/ 搜索“${search}”`;
    nav.append(suffix);
  }
}

function renderFileEntries(entries, { search = "" } = {}) {
  const container = $("#file-entry-list");
  container.replaceChildren();
  renderBreadcrumbs({ search });
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "file-list-empty";
    empty.textContent = search ? "没有找到匹配的文件" : "这个文件夹是空的";
    container.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "file-entry";
    row.dataset.kind = entry.kind;
    const icon = entry.kind === "directory" ? "▸" : (imagePreviewExtensions.has(fileExtension(entry.path)) ? "▧" : "□");
    row.innerHTML = `<span class="file-entry-name"><i>${icon}</i><strong>${escapeHtml(entry.name)}</strong></span><span>${formatModified(entry.modifiedAt)}</span><span>${entry.kind === "directory" ? "文件夹" : formatFileSize(entry.size)}</span>`;
    row.addEventListener("click", () => { void selectFileEntry(entry, row); });
    row.addEventListener("dblclick", () => { if (entry.kind === "directory") void browseDirectory(entry.path); });
    container.append(row);
  }
}

async function browseDirectory(path) {
  $("#file-browser-status").textContent = "正在读取目录…";
  try {
    const entries = await invoke("device_list_directory", { path });
    currentFilePath = path;
    const matchingRoot = fileRoots.find((root) => {
      const windowsPath = /\\/u.test(root);
      const candidate = windowsPath ? path.toLowerCase() : path;
      const base = windowsPath ? root.toLowerCase() : root;
      return candidate === base || candidate.startsWith(`${base.replace(/[\\/]$/u, "")}${windowsPath ? "\\" : "/"}`);
    });
    if (matchingRoot) activeFileRoot = matchingRoot;
    renderFileEntries(Array.isArray(entries) ? entries : []);
    $("#file-browser-status").textContent = `${entries.length} 个项目`;
    clearFilePreview();
  } catch (error) {
    $("#file-browser-status").textContent = error instanceof Error ? error.message : String(error);
  }
}

function clearFilePreview() {
  filePreviewGeneration += 1;
  selectedFileEntry = null;
  $("#file-preview-empty").hidden = false;
  $("#file-preview-content").hidden = true;
  $("#file-preview-body").replaceChildren();
  $("#file-send-status").textContent = "";
  $("#file-send-status").dataset.state = "idle";
}

async function selectFileEntry(entry, row) {
  const generation = ++filePreviewGeneration;
  selectedFileEntry = entry;
  for (const item of $$(".file-entry")) item.classList.toggle("selected", item === row);
  $("#file-preview-empty").hidden = true;
  $("#file-preview-content").hidden = false;
  $("#file-preview-name").textContent = entry.name;
  $("#file-preview-meta").textContent = entry.kind === "directory" ? "文件夹" : `${formatFileSize(entry.size)} · ${formatModified(entry.modifiedAt)}`;
  $("#file-preview-icon").textContent = entry.kind === "directory" ? "▸" : "□";
  $("#file-send-qq-button").disabled = entry.kind !== "file" || Number(entry.size) <= 0 || Number(entry.size) > 20 * 1024 * 1024;
  $("#file-send-status").textContent = Number(entry.size) > 20 * 1024 * 1024 ? "当前版本最多发送 20 MB" : "";
  $("#file-send-status").dataset.state = Number(entry.size) > 20 * 1024 * 1024 ? "error" : "idle";
  const body = $("#file-preview-body");
  body.replaceChildren();
  if (entry.kind === "directory") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-open-folder";
    button.textContent = "打开这个文件夹";
    button.addEventListener("click", () => { void browseDirectory(entry.path); });
    body.append(button);
    return;
  }
  const extension = fileExtension(entry.path);
  const loading = document.createElement("div");
  loading.className = "file-preview-message";
  loading.textContent = "正在生成预览…";
  body.append(loading);
  try {
    if (textPreviewExtensions.has(extension)) {
      const result = await invoke("device_read_text_file", { path: entry.path, maxChars: 20_000 });
      if (generation !== filePreviewGeneration) return;
      const pre = document.createElement("pre");
      pre.textContent = result.text;
      body.replaceChildren(pre);
      if (result.truncated) $("#file-preview-meta").textContent += " · 仅显示前 20,000 字";
    } else if (imagePreviewExtensions.has(extension)) {
      const result = await invoke("device_read_image_preview", { path: entry.path });
      if (generation !== filePreviewGeneration) return;
      const image = document.createElement("img");
      image.src = `data:${result.mediaType};base64,${result.data}`;
      image.alt = entry.name;
      body.replaceChildren(image);
    } else {
      loading.textContent = ["pdf", "docx", "xlsx"].includes(extension)
        ? "这份文档可以交给 Core 解析"
        : "当前文件类型暂不支持本地预览";
    }
  } catch (error) {
    if (generation !== filePreviewGeneration) return;
    loading.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function loadRoots() {
  try { fileRoots = (await invoke("device_get_file_roots"))?.roots || []; } catch { fileRoots = []; }
  $("#file-root-count").textContent = String(fileRoots.length);
  const container = $("#file-root-list");
  container.replaceChildren();
  if (!fileRoots.length) {
    const empty = document.createElement("div");
    empty.className = "root-empty";
    empty.textContent = "还没有授权目录";
    container.append(empty);
    renderFileEntries([]);
    return;
  }
  for (const root of fileRoots) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "root-item";
    item.innerHTML = `<span class="root-icon">⌑</span><span><strong>${escapeHtml(pathName(root))}</strong><small>${escapeHtml(root)}</small></span>`;
    item.addEventListener("click", () => { activeFileRoot = root; void browseDirectory(root); });
    container.append(item);
  }
  if (!currentFilePath) {
    activeFileRoot = fileRoots[0];
    await browseDirectory(activeFileRoot);
  }
}

async function chooseRoots() {
  try {
    await invoke("device_choose_file_roots");
    await loadRoots();
    await emit?.("companion:device-permissions-updated");
  } catch (error) {
    console.warn("[main] directory selection cancelled or failed", error);
  }
}
$("#files-choose-roots").addEventListener("click", chooseRoots);

$("#file-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $("#file-search-input").value.trim();
  if (!query) {
    if (currentFilePath) await browseDirectory(currentFilePath);
    return;
  }
  $("#file-browser-status").textContent = "正在搜索授权目录…";
  try {
    const entries = await invoke("device_search_files", { root: activeFileRoot, query, maxResults: 100 });
    renderFileEntries(Array.isArray(entries) ? entries : [], { search: query });
    $("#file-browser-status").textContent = `找到 ${entries.length} 个结果`;
    clearFilePreview();
  } catch (error) {
    $("#file-browser-status").textContent = error instanceof Error ? error.message : String(error);
  }
});

$("#file-reveal-button").addEventListener("click", async () => {
  if (!selectedFileEntry) return;
  await invoke("device_reveal_path", { path: selectedFileEntry.path });
});

$("#file-ask-button").addEventListener("click", async () => {
  if (!selectedFileEntry) return;
  const kind = selectedFileEntry.kind === "directory" ? "文件夹" : "文件";
  navigate("chat");
  await sendMainChat(`请查看我这台 Mac 上的${kind}：${selectedFileEntry.path}，告诉我它的主要内容`, { clearComposer: false });
});

$("#file-send-qq-button").addEventListener("click", async () => {
  if (!selectedFileEntry || selectedFileEntry.kind !== "file" || pendingFileSendRequest) return;
  const status = $("#file-send-status");
  if (loadDevicePermissions()["files.read_binary"] !== true) {
    status.dataset.state = "error";
    status.textContent = "请先到“设备与权限”开启“发送本机文件”";
    return;
  }
  if (currentConnection.state !== "online") {
    status.dataset.state = "error";
    status.textContent = "Windows Core 当前离线";
    return;
  }
  pendingFileSendRequest = crypto.randomUUID();
  $("#file-send-qq-button").disabled = true;
  status.dataset.state = "working";
  status.textContent = "正在加密传给 Windows Core…";
  window.clearTimeout(pendingFileSendTimer);
  pendingFileSendTimer = window.setTimeout(() => {
    if (!pendingFileSendRequest) return;
    pendingFileSendRequest = "";
    $("#file-send-qq-button").disabled = false;
    status.dataset.state = "error";
    status.textContent = "发送超时；请确认 Windows Core 已更新并在线";
  }, 120_000);
  try {
    await emit("companion:main-file-send", { requestId: pendingFileSendRequest, path: selectedFileEntry.path });
  } catch (error) {
    pendingFileSendRequest = "";
    window.clearTimeout(pendingFileSendTimer);
    $("#file-send-qq-button").disabled = false;
    status.dataset.state = "error";
    status.textContent = error instanceof Error ? error.message : String(error);
  }
});

async function renderScreenPermission() {
  try {
    const granted = await invoke("device_screen_permission_status");
    $("#main-screen-permission").textContent = granted ? "已允许" : "尚未允许；授权后需要重启客户端";
    $("#main-screen-request").disabled = granted;
    $("#main-screen-request").textContent = granted ? "已允许" : "申请权限";
  } catch { $("#main-screen-permission").textContent = "当前平台暂不支持检查"; }
}

$("#main-screen-request").addEventListener("click", async () => {
  try { await invoke("device_request_screen_permission"); } finally { window.setTimeout(renderScreenPermission, 900); }
});

function renderAudit() {
  const audit = loadDeviceAudit().slice().reverse();
  const container = $("#main-device-audit");
  container.replaceChildren();
  if (!audit.length) {
    const empty = document.createElement("div");
    empty.className = "audit-empty";
    empty.textContent = "暂无设备操作";
    container.append(empty);
    return;
  }
  const labels = Object.fromEntries(DEVICE_CAPABILITIES.map((item) => [item.id, item.label]));
  for (const item of audit) {
    const row = document.createElement("div");
    row.className = "audit-item";
    row.innerHTML = `<span>${new Date(item.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span><strong>${escapeHtml(labels[item.capability] || item.capability)}</strong><em class="${item.ok ? "" : "failed"}">${item.ok ? "完成" : "失败"}</em>`;
    container.append(row);
  }
}

const wardrobe = await loadEmiliaWardrobe();
const initialOutfit = loadSavedOutfit(wardrobe);
currentOutfitId = initialOutfit.id;
for (const outfit of wardrobe.outfits) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "outfit-card";
  button.dataset.outfit = outfit.id;
  button.setAttribute("aria-selected", String(outfit.id === currentOutfitId));
  const image = document.createElement("img");
  image.src = outfit.thumbnail;
  image.alt = "";
  const label = document.createElement("strong");
  label.textContent = outfit.name;
  button.append(image, label);
  button.addEventListener("click", async () => {
    await emit?.("companion:main-outfit-select", { outfitId: outfit.id });
  });
  $("#main-wardrobe").append(button);
}

function selectOutfitCard(outfitId) {
  currentOutfitId = outfitId;
  for (const button of $$(".outfit-card")) button.setAttribute("aria-selected", String(button.dataset.outfit === outfitId));
}

$("#main-quick-connect").addEventListener("click", async () => {
  const code = $("#main-connection-code").value.trim();
  const result = $("#main-connection-result");
  const button = $("#main-quick-connect");
  button.disabled = true;
  result.dataset.state = "idle";
  result.textContent = "正在验证中继与 Windows Core…";
  try {
    const invitation = parseConnectionCode(code);
    const config = validateConnectionConfig(invitation.mode === "relay" ? {
      mode: "relay", url: invitation.url, token: invitation.pairingCode, name: defaultClientName(navigator.platform),
    } : {
      mode: "direct", url: invitation.url, token: invitation.token, name: defaultClientName(navigator.platform),
    });
    const probe = await testConnection(config, { clientId: `desktop-main-setup-${crypto.randomUUID()}` });
    const verification = { fingerprint: connectionConfigFingerprint(probe.config), verifiedAt: Date.now(), serverName: probe.serverName };
    await savePersistentConnectionProfile(config, verification);
    result.dataset.state = "success";
    result.textContent = `${invitation.mode === "direct" ? "局域网" : "私有中继"}连接验证成功 · ${probe.serverName} · ${probe.latencyMs} ms`;
    $("#main-connection-code").value = "";
    await emit?.("companion:connection-profile-updated");
  } catch (error) {
    result.dataset.state = "error";
    result.textContent = error instanceof Error ? error.message : String(error);
  } finally { button.disabled = false; }
});

if (listen) {
  await listen("companion:navigate", ({ payload }) => navigate(typeof payload === "string" ? payload : payload?.page));
  await listen("companion:main-snapshot", ({ payload }) => applySnapshot(payload));
  await listen("companion:task-result", ({ payload }) => {
    if (!pendingTaskRequest || payload?.requestId !== pendingTaskRequest) return;
    pendingTaskRequest = "";
    $("#task-sync-state").textContent = payload?.ok ? "已同步" : "失败";
    $("#task-result").dataset.state = payload?.ok ? "success" : "error";
    $("#task-result").textContent = payload?.ok ? "任务已与 Core 同步" : (payload?.error || "任务同步失败");
    if (payload?.ok && Array.isArray(payload.tasks)) renderTasks(payload.tasks);
  });
  await listen("companion:main-chat-send-result", ({ payload }) => {
    if (!pendingChatRequest || payload?.requestId !== pendingChatRequest) return;
    const input = $("#main-chat-input");
    if (payload.ok && pendingChatClearsComposer) input.value = "";
    clearPendingChat({ error: payload.ok ? "" : (payload?.error || "消息发送失败") });
    input.focus();
  });
  await listen("companion:main-file-send-accepted", ({ payload }) => {
    if (!pendingFileSendRequest || payload?.requestId !== pendingFileSendRequest || payload?.ok) return;
    pendingFileSendRequest = "";
    window.clearTimeout(pendingFileSendTimer);
    $("#file-send-qq-button").disabled = false;
    $("#file-send-status").dataset.state = "error";
    $("#file-send-status").textContent = payload?.error || "文件发送失败";
  });
  await listen("companion:file-send-state", ({ payload }) => {
    if (!pendingFileSendRequest || payload?.requestId !== pendingFileSendRequest) return;
    $("#file-send-status").dataset.state = "working";
    $("#file-send-status").textContent = "正在安全传输并上传到 QQ…";
  });
  await listen("companion:file-send-result", ({ payload }) => {
    if (!pendingFileSendRequest || payload?.requestId !== pendingFileSendRequest) return;
    pendingFileSendRequest = "";
    window.clearTimeout(pendingFileSendTimer);
    $("#file-send-qq-button").disabled = false;
    $("#file-send-status").dataset.state = payload?.ok ? "success" : "error";
    $("#file-send-status").textContent = payload?.ok
      ? `“${payload.name || "文件"}”已发送到你的 QQ`
      : (payload?.error || "文件发送失败");
  });
  await listen("companion:chat-appended", ({ payload }) => appendMessage(payload));
  await listen("companion:connection-state", ({ payload }) => updateConnection(payload));
  await listen("companion:assistant-state", ({ payload }) => {
    $("#main-typing").hidden = payload?.state !== "thinking";
    $("#current-activity").textContent = payload?.state === "thinking" ? "正在想怎么回答你" : "在等你说话";
  });
  await listen("companion:emotion-state", ({ payload }) => {
    $("#current-emotion").textContent = emotionLabel(payload?.emotion);
  });
  await listen("companion:outfit-changed", ({ payload }) => selectOutfitCard(payload?.outfitId));
  await emit("companion:main-request-snapshot");
  window.setTimeout(() => { void emit("companion:main-request-snapshot"); }, 400);
}

window.addEventListener("storage", (event) => {
  if (event.key === HISTORY_KEY) renderHistory(storedHistory());
  renderPermissions();
  renderAudit();
});

await Promise.allSettled([renderDeviceInfo(), loadRoots(), renderScreenPermission()]);
renderPermissions();
renderAudit();
updateConnection();
navigate(currentPage);
window.dispatchEvent(new CustomEvent("companion:ready"));

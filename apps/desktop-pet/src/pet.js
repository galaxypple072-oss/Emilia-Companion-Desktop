import "./startup-diagnostics.js";
import { PET_STATES, PetAnimationController, isPetState } from "./state-machine.js";
import { createLive2DPet } from "./live2d-pet.js";
import { createMouseTracker } from "./mouse-tracker.js";
import { loadEmiliaWardrobe, loadSavedOutfit, resolveOutfit, saveOutfit } from "./emilia-wardrobe.js";
import { connectionConfigFingerprint, testConnection, validateConnectionConfig } from "./connection-client.js";
import { defaultClientName } from "./connection-profile.js";
import { loadPersistentConnectionProfile, savePersistentConnectionProfile } from "./persistent-connection-profile.js";
import { parseConnectionCode } from "../../../packages/companion-relay-protocol/src/index.js";
import { DEVICE_CAPABILITIES, loadDeviceAudit, loadDevicePermissions, saveDevicePermissions } from "./device-control.js";

const calibrationEnabled = new URLSearchParams(window.location.search).get("calibrate") === "1";
document.documentElement.dataset.calibrate = String(calibrationEnabled);

const sprite = document.querySelector("#pet-sprite");
const live2dCanvas = document.querySelector("#live2d-canvas");
const bubble = document.querySelector("#speech-bubble");
const stateLabel = document.querySelector("#state-label");
const controls = document.querySelector(".pet-controls");
const framingPanel = document.querySelector("#framing-panel");
const chatPanel = document.querySelector("#chat-panel");
const chatToggle = document.querySelector("#chat-toggle");
const wardrobePanel = document.querySelector("#wardrobe-panel");
const wardrobeToggle = document.querySelector("#wardrobe-toggle");
const portraitHide = document.querySelector("#portrait-hide");
const appQuit = document.querySelector("#app-quit");
const wardrobeClose = document.querySelector("#wardrobe-close");
const wardrobeOptions = document.querySelector("#wardrobe-options");
const wardrobeStatus = document.querySelector("#wardrobe-status");
const settingsToggle = document.querySelector("#settings-toggle");
const chatClose = document.querySelector("#chat-close");
const settingsClose = document.querySelector("#settings-close");
const connectionForm = document.querySelector("#connection-form");
const connectionStatus = document.querySelector("#connection-status");
const connectionCheck = document.querySelector("#connection-check");
const connectionTest = document.querySelector("#connection-test");
const connectionSave = document.querySelector("#connection-save");
const connectionCode = document.querySelector("#connection-code");
const connectionQuickConnect = document.querySelector("#connection-quick-connect");
const tokenVisibility = document.querySelector("#token-visibility");
const connectionMode = document.querySelector("#connection-mode");
const connectionUrlLabel = document.querySelector("#connection-url-label");
const connectionUrlHelp = document.querySelector("#connection-url-help");
const connectionTokenLabel = document.querySelector("#connection-token-label");
const connectionPrivacy = document.querySelector("#connection-privacy");
const chatMessages = document.querySelector("#chat-messages");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const typingIndicator = document.querySelector("#typing-indicator");
const quickChatForm = document.querySelector("#quick-chat-form");
const quickChatInput = document.querySelector("#quick-chat-input");
const quickLastMessage = document.querySelector("#quick-last-message");
const devicePermissionList = document.querySelector("#device-permission-list");
const deviceAuditList = document.querySelector("#device-audit-list");
const deviceFileRootsChoose = document.querySelector("#device-file-roots-choose");
const deviceFileRootsSummary = document.querySelector("#device-file-roots-summary");
const deviceScreenPermissionRequest = document.querySelector("#device-screen-permission-request");
const deviceScreenPermissionSummary = document.querySelector("#device-screen-permission-summary");
if (!(sprite instanceof HTMLImageElement) || !(live2dCanvas instanceof HTMLCanvasElement) || !(bubble instanceof HTMLOutputElement) || !stateLabel || !controls) {
  throw new Error("Desktop pet DOM is incomplete");
}

const controller = new PetAnimationController();
let lastFrameAt = performance.now();
let bubbleTimer = 0;
let activeState = PET_STATES.IDLE;
let live2dPet = null;
let mouseTracker = null;
let chatExpanded = false;
let wardrobeExpanded = false;
let outfitLoading = false;

const wardrobe = await loadEmiliaWardrobe();
let selectedOutfit = loadSavedOutfit(wardrobe);

function syncWardrobeSelection() {
  for (const button of wardrobeOptions.querySelectorAll("button[data-outfit]")) {
    button.setAttribute("aria-selected", String(button.dataset.outfit === selectedOutfit.id));
  }
}

for (const outfit of wardrobe.outfits) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "wardrobe-option";
  button.dataset.outfit = outfit.id;
  button.setAttribute("role", "option");
  button.setAttribute("aria-label", outfit.name);
  button.disabled = true;
  const preview = document.createElement("img");
  preview.src = outfit.thumbnail;
  preview.alt = "";
  const label = document.createElement("span");
  label.textContent = outfit.shortName;
  button.append(preview, label);
  wardrobeOptions.append(button);
}
syncWardrobeSelection();

const HISTORY_KEY = "emilia.chat.history.v1";
const CLIENT_ID_KEY = "emilia.client.id.v1";
const clientId = localStorage.getItem(CLIENT_ID_KEY) || crypto.randomUUID();
localStorage.setItem(CLIENT_ID_KEY, clientId);
const nativeInvoke = window.__TAURI__?.core?.invoke ?? (async () => { throw new Error("设备能力只在桌面客户端中可用"); });
function applyPortraitVisibility(hidden) {
  const isHidden = hidden === true;
  document.documentElement.dataset.portraitHidden = String(isHidden);
  portraitHide.textContent = isHidden ? "显" : "▣";
  portraitHide.setAttribute("aria-label", isHidden ? "显示立绘" : "隐藏立绘，仅保留快捷对话和控制栏");
  portraitHide.title = isHidden ? "显示立绘" : "隐藏立绘，仅保留快捷对话和控制栏";
  if (!isHidden) {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => live2dPet?.refreshLayout()));
  }
}
void nativeInvoke("pet_portrait_is_hidden").then(applyPortraitVisibility).catch(() => applyPortraitVisibility(false));
function reportDiagnostic(message) {
  void nativeInvoke("frontend_report_error", { message: `[diagnostic] ${message}` }).catch(() => {});
}
const tauriEvent = window.__TAURI__?.event;
function emitToMain(event, payload) {
  return tauriEvent?.emit?.(event, payload).catch((error) => console.warn(`[desktop] failed to emit ${event}`, error));
}
function renderDeviceAudit(audit = loadDeviceAudit()) {
  const labels = Object.fromEntries(DEVICE_CAPABILITIES.map((item) => [item.id, item.label]));
  deviceAuditList.textContent = audit.length ? audit.slice(-5).reverse().map((item) => {
    const time = new Date(item.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return `${time} · ${labels[item.capability] || item.capability} · ${item.ok ? "完成" : "拒绝/失败"}`;
  }).join("\n") : "暂无操作";
}
renderDeviceAudit();

async function renderDeviceFileRoots(value) {
  let payload = value;
  if (!payload) {
    try { payload = await nativeInvoke("device_get_file_roots"); } catch { payload = { roots: [] }; }
  }
  const roots = Array.isArray(payload?.roots) ? payload.roots : [];
  deviceFileRootsSummary.textContent = roots.length ? roots.join(" · ") : "尚未选择，文件能力无法使用";
  deviceFileRootsSummary.title = roots.join("\n");
}
void renderDeviceFileRoots();

async function renderScreenPermission() {
  try {
    const granted = await nativeInvoke("device_screen_permission_status");
    deviceScreenPermissionSummary.textContent = granted ? "已允许" : "尚未允许；申请后需重启桌宠";
    deviceScreenPermissionRequest.textContent = granted ? "已允许" : "申请权限";
    deviceScreenPermissionRequest.disabled = granted;
    return granted;
  } catch {
    deviceScreenPermissionSummary.textContent = "无法检查系统权限";
    return false;
  }
}
void renderScreenPermission();

deviceScreenPermissionRequest.addEventListener("click", async () => {
  deviceScreenPermissionRequest.disabled = true;
  try {
    const granted = await nativeInvoke("device_request_screen_permission");
    deviceScreenPermissionSummary.textContent = granted
      ? "已允许；请重启桌宠后使用"
      : "请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许 Emilia Companion";
  } catch (error) {
    deviceScreenPermissionSummary.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    window.setTimeout(() => { void renderScreenPermission(); }, 1200);
  }
});

deviceFileRootsChoose.addEventListener("click", async () => {
  deviceFileRootsChoose.disabled = true;
  try {
    const result = await nativeInvoke("device_choose_file_roots");
    await renderDeviceFileRoots(result);
    void emitToMain("companion:device-permissions-updated");
  } catch (error) {
    deviceFileRootsSummary.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    deviceFileRootsChoose.disabled = false;
  }
});

function renderDevicePermissions() {
  const permissions = loadDevicePermissions();
  devicePermissionList.replaceChildren();
  for (const capability of DEVICE_CAPABILITIES) {
    const label = document.createElement("label");
    label.className = "device-permission-option";
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = capability.label;
    const detail = document.createElement("small");
    detail.textContent = capability.detail;
    copy.append(title, detail);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.deviceCapability = capability.id;
    input.checked = permissions[capability.id] === true;
    input.disabled = capability.locked === true;
    label.append(copy, input);
    devicePermissionList.append(label);
  }
}
renderDevicePermissions();

devicePermissionList.addEventListener("change", async () => {
  const permissions = Object.fromEntries([...devicePermissionList.querySelectorAll("input[data-device-capability]")]
    .map((input) => [input.dataset.deviceCapability, input.checked]));
  const normalized = saveDevicePermissions(permissions);
  await nativeInvoke("device_save_permissions", { permissions: normalized });
  void emitToMain("companion:device-permissions-updated");
});

function storedJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "") ?? fallback;
  } catch {
    return fallback;
  }
}

let chatHistory = storedJson(HISTORY_KEY, []);
if (!Array.isArray(chatHistory)) chatHistory = [];
let verifiedConnection = null;
let testingConnection = false;
let activeConnectionProfile = null;
let connectionRuntimeState = { state: "offline", label: "离线", serverName: "" };

function formBridgeConfig() {
  return validateConnectionConfig({
    mode: connectionForm.elements.mode.value,
    url: connectionForm.elements.url.value,
    token: connectionForm.elements.token.value,
    name: connectionForm.elements.name.value,
  });
}

function syncConnectionMode() {
  const relay = connectionForm.elements.mode.value === "relay";
  connectionUrlLabel.textContent = relay ? "中继地址" : "Core 地址";
  connectionUrlHelp.textContent = relay ? "两端都主动连接它，不受校园网 IP 变化影响" : "可以只填 Windows IP，默认使用 8765 端口";
  connectionTokenLabel.textContent = relay ? "配对码" : "访问 Token";
  connectionForm.elements.url.placeholder = relay ? "例如 relay.example.com" : "例如 10.89.38.169";
  connectionForm.elements.token.placeholder = relay ? "粘贴 Windows Core 生成的配对码" : "粘贴 Core 生成的 Token";
  connectionPrivacy.textContent = relay ? "配对密钥只保存在两端，中继无法解密聊天内容" : "Token 只保存在当前设备，不会进入聊天记录";
}

function setConnectionCheck(state, title, detail) {
  connectionCheck.dataset.state = state;
  connectionCheck.querySelector("strong").textContent = title;
  connectionCheck.querySelector("small").textContent = detail;
}

function resetConnectionVerification() {
  verifiedConnection = null;
  connectionSave.disabled = true;
  if (!testingConnection) setConnectionCheck("idle", "等待连接", "粘贴连接码后会自动验证 Core");
}

function showConnectionWizard() {
  connectionForm.classList.remove("collapsed");
  window.setTimeout(() => connectionCode.focus(), 80);
}

function appendChat(role, text, persist = true) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return;
  const item = document.createElement("p");
  item.className = `chat-message ${role}`;
  item.textContent = normalized;
  chatMessages.append(item);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  if (role === "user") {
    quickLastMessage.textContent = normalized;
    quickLastMessage.hidden = false;
    quickLastMessage.title = normalized;
  }
  if (persist) {
    const entry = { role, text: normalized, at: Date.now() };
    chatHistory.push(entry);
    chatHistory = chatHistory.slice(-60);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(chatHistory));
    void emitToMain("companion:chat-appended", entry);
  }
}

for (const item of chatHistory.slice(-30)) {
  if (item && ["user", "assistant", "system"].includes(item.role) && typeof item.text === "string") appendChat(item.role, item.text, false);
}

async function resizeForChat(expanded) {
  document.documentElement.dataset.chatOpen = String(expanded);
  chatPanel.setAttribute("aria-hidden", String(!expanded));
  const invoke = window.__TAURI__?.core?.invoke;
  if (invoke) {
    try {
      await invoke("set_chat_expanded", { expanded });
    } catch (error) {
      console.warn("[desktop] failed to resize chat window", error);
    }
  }
  if (expanded) window.setTimeout(() => chatInput.focus(), 80);
}

async function resizeForWardrobe(expanded) {
  document.documentElement.dataset.wardrobeOpen = String(expanded);
  wardrobePanel.setAttribute("aria-hidden", String(!expanded));
  const invoke = window.__TAURI__?.core?.invoke;
  if (invoke) {
    try {
      await invoke("set_wardrobe_expanded", { expanded });
    } catch (error) {
      console.warn("[desktop] failed to resize wardrobe window", error);
    }
  }
}

const motionByEmotion = {
  neutral: "Idle", happy: "Smile", concerned: "Think", think: "Think", surprise: "Surprise", shy: "Shy", angry: "Angry", sad: "Shy",
};
const allowedMotions = new Set(["Idle", "Smile", "Think", "Surprise", "Shy", "Angry"]);

function applyAgentState({ state = "offline", label = "离线", message = "", serverName = "", transport = "", retryInMs = 0, transient = true } = {}) {
    reportDiagnostic(`connection state=${state} label=${label || ""}${message ? ` detail=${message}` : ""}`);
    connectionRuntimeState = { state, label, message: message || "", serverName: serverName || "", transport, retryInMs, transient };
    void emitToMain("companion:connection-state", connectionRuntimeState);
    connectionStatus.dataset.state = state;
    connectionStatus.textContent = label;
    if (state === "online") {
      try {
        const config = formBridgeConfig();
        verifiedConnection = {
          fingerprint: connectionConfigFingerprint(config),
          verifiedAt: Date.now(),
          serverName: serverName || "Emilia Core",
        };
        connectionSave.disabled = false;
        setConnectionCheck("success", "连接正常", "已经通过 Core 身份验证");
        const currentFingerprint = activeConnectionProfile
          ? connectionConfigFingerprint(activeConnectionProfile)
          : "";
        if (currentFingerprint !== verifiedConnection.fingerprint) {
          void savePersistentConnectionProfile(config, verifiedConnection).then((profile) => {
            activeConnectionProfile = profile;
          });
        }
      } catch { /* the active socket may predate the visible form */ }
    } else if (state === "error" && !connectionForm.classList.contains("collapsed")) {
      setConnectionCheck("error", label, message || "请检查地址和 Token");
    }
    if (message && !transient) appendChat("system", message);
}

function handleTransportEvent(event) {
    if (!event || event.type === "device.command") return;
    if (event.type === "voice.audio.begin" && typeof event.id === "string") {
      voiceTransfers.set(event.id, { mimeType: event.mimeType || "audio/wav", total: Number(event.total) || 0, chunks: [] });
      reportDiagnostic(`[voice] transfer started chunks=${Number(event.total) || 0}`);
      return;
    }
    if (event.type === "voice.audio.chunk" && typeof event.id === "string" && typeof event.data === "string") {
      const transfer = voiceTransfers.get(event.id);
      if (transfer) transfer.chunks[Number(event.index) || 0] = event.data;
      return;
    }
    if (event.type === "voice.audio.end" && typeof event.id === "string") {
      const transfer = voiceTransfers.get(event.id);
      voiceTransfers.delete(event.id);
      if (transfer && transfer.chunks.length === transfer.total) void playVoiceTransfer(transfer);
      else reportDiagnostic("[voice] transfer incomplete; audio was not played");
      return;
    }
    if (event.type === "tasks.result") {
      void emitToMain("companion:task-result", event);
      return;
    }
    if (event.type === "file.send_qq.state") {
      void emitToMain("companion:file-send-state", event);
      return;
    }
    if (event.type === "file.send_qq.result") {
      void emitToMain("companion:file-send-result", event);
      say(event.ok ? `${event.name || "文件"}已经发到 QQ 了` : (event.error || "文件没有发出去"), 3200);
      return;
    }
    if (event.type === "assistant.state") {
      typingIndicator.hidden = event.state !== "thinking";
      void emitToMain("companion:assistant-state", { state: event.state });
      if (event.state === "thinking") void live2dPet?.motion("Think");
    }
    if (event.type === "assistant.reply" && typeof event.text === "string") {
      typingIndicator.hidden = true;
      appendChat("assistant", event.text);
      say(event.text, 3200);
      document.documentElement.dataset.emotion = event.emotion || "neutral";
      document.documentElement.style.setProperty("--emotion-intensity", String(Number(event.intensity) || 0));
      void emitToMain("companion:emotion-state", { emotion: event.emotion || "neutral", intensity: Number(event.intensity) || 0 });
      const motion = allowedMotions.has(event.motion) ? event.motion : motionByEmotion[event.emotion] || "Idle";
      if (event.index === undefined || event.index === 0) void live2dPet?.motion(motion);
    }
}

const voiceTransfers = new Map();
let activeVoice = null;
async function playVoiceTransfer(transfer) {
  try {
    const chunks = transfer.chunks.map((base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
    const blob = new Blob(chunks, { type: transfer.mimeType });
    if (activeVoice) { activeVoice.pause(); URL.revokeObjectURL(activeVoice.src); }
    live2dPet?.stopLipSync();
    const audio = new Audio(URL.createObjectURL(blob));
    activeVoice = audio;
    audio.addEventListener("ended", () => {
      URL.revokeObjectURL(audio.src);
      if (activeVoice === audio) activeVoice = null;
      live2dPet?.stopLipSync();
      void live2dPet?.motion("Idle");
    }, { once: true });
    audio.addEventListener("error", () => {
      URL.revokeObjectURL(audio.src);
      if (activeVoice === audio) activeVoice = null;
      live2dPet?.stopLipSync();
      void live2dPet?.motion("Idle");
    }, { once: true });
    const lipSyncReady = await live2dPet?.startLipSync(await blob.arrayBuffer());
    void live2dPet?.motion("Talk");
    await audio.play();
    reportDiagnostic(`[voice] playback started bytes=${blob.size} lipsync=${lipSyncReady === false ? "off" : "on"}`);
  } catch (error) {
    live2dPet?.stopLipSync();
    reportDiagnostic(`[voice] playback failed: ${error instanceof Error ? error.message : String(error)}`);
    console.warn("[voice] playback failed", error);
  }
}

async function connectSavedProfile() {
  const profile = await loadPersistentConnectionProfile({ platform: navigator.platform });
  reportDiagnostic(profile ? `secure profile loaded mode=${profile.mode || "direct"}` : "no saved connection profile");
  activeConnectionProfile = profile;
  connectionForm.elements.name.value = profile?.name || defaultClientName(navigator.platform);
  if (!profile) return false;
  connectionForm.elements.mode.value = profile.mode || "direct";
  connectionForm.elements.url.value = profile.url || "";
  connectionForm.elements.token.value = profile.token || "";
  connectionForm.elements.name.value = profile.name || defaultClientName(navigator.platform);
  return true;
}
await connectSavedProfile();
syncConnectionMode();

function setChatExpanded(expanded) {
  if (expanded && wardrobeExpanded) {
    wardrobeExpanded = false;
    document.documentElement.dataset.wardrobeOpen = "false";
    wardrobePanel.setAttribute("aria-hidden", "true");
  }
  chatExpanded = expanded;
  if (!expanded) connectionForm.classList.add("collapsed");
  void resizeForChat(expanded);
}

function setWardrobeExpanded(expanded) {
  if (expanded && chatExpanded) {
    chatExpanded = false;
    connectionForm.classList.add("collapsed");
    document.documentElement.dataset.chatOpen = "false";
    chatPanel.setAttribute("aria-hidden", "true");
  }
  wardrobeExpanded = expanded;
  void resizeForWardrobe(expanded);
}

async function openMainWindow(page) {
  try { await nativeInvoke("show_main_window", { page }); }
  catch (error) { console.warn("[desktop] failed to open main window", error); }
}

chatToggle.addEventListener("click", () => { void openMainWindow("chat"); });
chatClose.addEventListener("click", () => setChatExpanded(false));
wardrobeToggle.addEventListener("click", () => { void openMainWindow("appearance"); });
wardrobeClose.addEventListener("click", () => setWardrobeExpanded(false));
portraitHide.addEventListener("click", async () => {
  portraitHide.disabled = true;
  const hidden = document.documentElement.dataset.portraitHidden !== "true";
  try {
    await nativeInvoke("set_pet_portrait_hidden", { hidden });
    applyPortraitVisibility(hidden);
  }
  catch (error) { console.warn("[desktop] failed to hide portrait", error); }
  finally { portraitHide.disabled = false; }
});
appQuit.addEventListener("click", () => { void nativeInvoke("quit_application"); });

void tauriEvent?.listen?.("companion:portrait-visibility", ({ payload }) => applyPortraitVisibility(payload === true));

settingsToggle.addEventListener("click", () => {
  if (connectionForm.classList.contains("collapsed")) showConnectionWizard();
  else connectionForm.classList.add("collapsed");
});
settingsClose.addEventListener("click", () => connectionForm.classList.add("collapsed"));

connectionForm.addEventListener("input", resetConnectionVerification);
connectionMode.addEventListener("change", () => {
  syncConnectionMode();
  resetConnectionVerification();
});

tokenVisibility.addEventListener("click", () => {
  const visible = connectionForm.elements.token.type === "text";
  connectionForm.elements.token.type = visible ? "password" : "text";
  tokenVisibility.textContent = visible ? "显示" : "隐藏";
  tokenVisibility.setAttribute("aria-pressed", String(!visible));
  tokenVisibility.setAttribute("aria-label", visible ? "显示 Token" : "隐藏 Token");
});

async function probeConnection(config) {
  if (testingConnection) return;
  testingConnection = true;
  connectionTest.disabled = true;
  connectionQuickConnect.disabled = true;
  connectionSave.disabled = true;
  setConnectionCheck("testing", "正在连接", "正在验证中继和 Windows Core…");
  try {
    const result = await testConnection(config, { clientId });
    if (result.config.token !== config.token) connectionForm.elements.token.value = result.config.token;
    verifiedConnection = {
      fingerprint: connectionConfigFingerprint(result.config),
      verifiedAt: Date.now(),
      serverName: result.serverName,
    };
    connectionSave.disabled = false;
    setConnectionCheck("success", result.serverName, `验证成功 · ${result.latencyMs} ms`);
    return { result, verification: verifiedConnection };
  } catch (error) {
    verifiedConnection = null;
    setConnectionCheck("error", "连接失败", error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    testingConnection = false;
    connectionTest.disabled = false;
    connectionQuickConnect.disabled = false;
  }
}

connectionQuickConnect.addEventListener("click", async () => {
  let config;
  try {
    const invitation = parseConnectionCode(connectionCode.value);
    connectionForm.elements.mode.value = invitation.mode;
    connectionForm.elements.url.value = invitation.url;
    connectionForm.elements.token.value = invitation.mode === "relay" ? invitation.pairingCode : invitation.token;
    connectionForm.elements.name.value ||= defaultClientName(navigator.platform);
    syncConnectionMode();
    config = formBridgeConfig();
  } catch (error) {
    setConnectionCheck("error", "连接码无效", error instanceof Error ? error.message : String(error));
    return;
  }
  const verified = await probeConnection(config);
  if (!verified) return;
  try {
    const profile = await savePersistentConnectionProfile(config, verified.verification);
    activeConnectionProfile = profile;
    await emitToMain("companion:connection-profile-updated");
    connectionCode.value = "";
    connectionForm.classList.add("collapsed");
  } catch (error) {
    setConnectionCheck("error", "保存失败", error instanceof Error ? error.message : String(error));
  }
});

connectionTest.addEventListener("click", async () => {
  let config;
  try {
    config = formBridgeConfig();
  } catch (error) {
    setConnectionCheck("error", "信息有误", error instanceof Error ? error.message : String(error));
    return;
  }
  await probeConnection(config);
});

connectionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const profile = await savePersistentConnectionProfile(formBridgeConfig(), verifiedConnection);
    activeConnectionProfile = profile;
    await emitToMain("companion:connection-profile-updated");
    connectionForm.classList.add("collapsed");
  } catch (error) {
    setConnectionCheck("error", "还不能保存", error instanceof Error ? error.message : String(error));
  }
});

function sendMessage(rawText, input = null) {
  const text = String(rawText ?? "").trim();
  if (!text) return { ok: false, error: "消息不能为空" };
  try {
    if (connectionRuntimeState.state !== "online") throw new Error("Core 还没有连接好");
    void emitToMain("companion:transport-chat-send", { text, requestId: crypto.randomUUID() });
    appendChat("user", text);
    if (input) input.value = "";
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    say(activeConnectionProfile ? message : "还没连接 Core，点“聊”完成设置", 3200);
    return { ok: false, error: message };
  }
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(chatInput.value, chatInput);
});

quickChatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(quickChatInput.value, quickChatInput);
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

function syncFramingPanel(framing) {
  if (!calibrationEnabled || !framingPanel || !framing) return;
  for (const key of ["scale", "x", "y"]) {
    const input = framingPanel.querySelector(`[data-framing="${key}"]`);
    const output = framingPanel.querySelector(`[data-value="${key}"]`);
    input.value = String(framing[key]);
    output.value = String(framing[key]);
  }
}

framingPanel?.addEventListener("input", () => {
  if (!live2dPet) return;
  const framing = Object.fromEntries(
    ["scale", "x", "y"].map((key) => [
      key,
      Number(framingPanel.querySelector(`[data-framing="${key}"]`).value),
    ]),
  );
  live2dPet.setFraming(framing);
  syncFramingPanel(framing);
});

framingPanel?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (!button || !live2dPet) return;
  live2dPet.setView(button.dataset.view);
  syncFramingPanel(live2dPet.framing);
});

controller.subscribe(({ state, src }) => {
  activeState = state;
  if (live2dPet) {
    live2dPet.setState(state);
  } else if (sprite.getAttribute("src") !== src) {
    sprite.src = src;
  }
  stateLabel.textContent = state;
  document.documentElement.dataset.petState = state;
});

function say(text, durationMs = 2400) {
  const normalized = String(text ?? "").trim().slice(0, 120);
  window.clearTimeout(bubbleTimer);
  bubble.textContent = normalized;
  bubble.classList.toggle("visible", Boolean(normalized));
  if (normalized) {
    bubbleTimer = window.setTimeout(() => bubble.classList.remove("visible"), durationMs);
  }
}

function setState(state, options) {
  if (!isPetState(state)) return false;
  return controller.setState(state, options);
}

function animate(now) {
  // Vite HMR can replace this module while an older RAF callback is queued.
  controller.advance(Math.max(0, now - lastFrameAt));
  lastFrameAt = now;
  window.requestAnimationFrame(animate);
}

controls.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-motion]");
  if (!button) return;
  const motion = button.dataset.motion;
  if (live2dPet) {
    void live2dPet.motion(motion);
  } else {
    setState(motion === "Surprise" ? PET_STATES.CASTING : PET_STATES.IDLE, { restart: true });
  }
  const labels = {
    Idle: "嗯，我在",
    Smile: "嘿嘿",
    Think: "让我想想",
    Surprise: "诶？",
    Shy: "唔…",
  };
  say(labels[motion]);
});

async function selectOutfit(outfitId) {
  const outfit = resolveOutfit(wardrobe, outfitId);
  if (!live2dPet || outfitLoading || live2dPet.outfit?.id === outfit.id) return false;
  outfitLoading = true;
  wardrobePanel.dataset.loading = "true";
  wardrobeStatus.value = `正在换上${outfit.name}…`;
  try {
    await live2dPet.setOutfit(outfit);
    selectedOutfit = outfit;
    saveOutfit(outfit.id);
    syncWardrobeSelection();
    wardrobeStatus.value = outfit.name;
    document.documentElement.dataset.outfit = outfit.id;
    void emitToMain("companion:outfit-changed", { outfitId: outfit.id });
    return true;
  } catch (error) {
    console.error(`[live2d] failed to switch outfit to ${outfit.id}`, error);
    wardrobeStatus.value = "这套暂时换不上";
    return false;
  } finally {
    outfitLoading = false;
    wardrobePanel.dataset.loading = "false";
  }
}

wardrobeOptions.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-outfit]");
  if (!button) return;
  void selectOutfit(button.dataset.outfit);
});

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.key === "Escape" && wardrobeExpanded) {
    setWardrobeExpanded(false);
    return;
  }
  if (event.key === "Escape" && chatExpanded) {
    if (!connectionForm.classList.contains("collapsed")) connectionForm.classList.add("collapsed");
    else setChatExpanded(false);
    return;
  }
  const keyStates = {
    ArrowLeft: PET_STATES.WALK_LEFT,
    ArrowRight: PET_STATES.WALK_RIGHT,
    " ": PET_STATES.CASTING,
    Escape: PET_STATES.IDLE,
  };
  const state = keyStates[event.key];
  if (state) setState(state, { restart: state === PET_STATES.CASTING });
});

window.addEventListener("companion:state", (event) => {
  const detail = event.detail ?? {};
  if (detail.text !== undefined) say(detail.text, detail.durationMs);
  if (detail.state !== undefined) setState(detail.state, { restart: Boolean(detail.restart) });
});

Object.defineProperty(window, "companionPet", {
  value: Object.freeze({
    setState,
    say,
    states: PET_STATES,
    motion: (group, index) => live2dPet?.motion(group, index) ?? Promise.resolve(null),
    setView: (view) => live2dPet?.setView(view) ?? false,
    setFraming: (framing) => live2dPet?.setFraming(framing) ?? false,
    lookAt: (x, y) => live2dPet?.lookAt(x, y),
    setOutfit: (outfitId) => selectOutfit(outfitId),
    outfits: wardrobe.outfits,
  }),
  writable: false,
});

async function wireMainWindow() {
  if (!tauriEvent?.listen) return;
  await tauriEvent.listen("companion:main-chat-send", ({ payload }) => {
    const result = sendMessage(payload?.text);
    void emitToMain("companion:main-chat-send-result", { requestId: payload?.requestId, ...result });
  });
  await tauriEvent.listen("companion:main-file-send", ({ payload }) => {
    try {
      if (connectionRuntimeState.state !== "online") throw new Error("Core 还没有连接好");
      const requestId = payload?.requestId || crypto.randomUUID();
      void emitToMain("companion:transport-file-send", { path: payload?.path, requestId });
      void emitToMain("companion:main-file-send-accepted", { requestId, ok: true });
    } catch (error) {
      void emitToMain("companion:main-file-send-accepted", {
        requestId: payload?.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  await tauriEvent.listen("companion:main-outfit-select", ({ payload }) => {
    void selectOutfit(payload?.outfitId);
  });
  await tauriEvent.listen("companion:main-request-snapshot", () => {
    void emitToMain("companion:main-snapshot", {
      history: chatHistory,
      connection: connectionRuntimeState,
      outfitId: selectedOutfit.id,
      emotion: document.documentElement.dataset.emotion || "neutral",
      thinking: !typingIndicator.hidden,
    });
  });
  await tauriEvent.listen("companion:connection-profile-updated", async () => {
    await connectSavedProfile();
    syncConnectionMode();
  });
  await tauriEvent.listen("companion:device-permissions-updated", () => {
    renderDevicePermissions();
    void renderDeviceFileRoots();
    void renderScreenPermission();
  });
  await tauriEvent.listen("companion:agent-state", ({ payload }) => applyAgentState(payload));
  await tauriEvent.listen("companion:transport-event", ({ payload }) => handleTransportEvent(payload));
  await tauriEvent.listen("companion:transport-error", ({ payload }) => {
    if (payload?.error) {
      appendChat("system", payload.error);
      void emitToMain("companion:file-send-result", { requestId: payload.requestId, ok: false, error: payload.error });
    }
  });
  await emitToMain("companion:agent-state-request");
}
void wireMainWindow();

say("我在", 1400);
window.requestAnimationFrame(animate);
window.dispatchEvent(new CustomEvent("companion:ready", { detail: { states: Object.values(PET_STATES) } }));

createLive2DPet(live2dCanvas, { outfit: selectedOutfit })
  .then((pet) => {
    live2dPet = pet;
    document.documentElement.dataset.renderer = "live2d";
    pet.setState(activeState, { restart: true });
    document.documentElement.dataset.outfit = pet.outfit.id;
    wardrobeStatus.value = pet.outfit.name;
    for (const button of wardrobeOptions.querySelectorAll("button[data-outfit]")) button.disabled = false;
    syncFramingPanel(pet.framing);
    mouseTracker?.stop();
    mouseTracker = createMouseTracker({
      canvas: live2dCanvas,
      onGaze: ({ x, y }) => pet.lookAt(x, y),
    });
    window.dispatchEvent(new CustomEvent("companion:live2d-ready", {
      detail: { groups: pet.groups, views: pet.views, view: pet.view },
    }));
  })
  .catch((error) => {
    console.error("[live2d] failed to initialize; keeping sprite fallback", error);
    document.documentElement.dataset.renderer = "sprite";
  });

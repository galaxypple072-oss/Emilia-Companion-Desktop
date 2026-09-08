import "./startup-diagnostics.js";
import { CompanionConnectionClient } from "./connection-client.js";
import { defaultClientName } from "./connection-profile.js";
import { DeviceControlAgent, saveDevicePermissions } from "./device-control.js";
import { loadPersistentConnectionProfile } from "./persistent-connection-profile.js";

const invoke = window.__TAURI__?.core?.invoke;
const events = window.__TAURI__?.event;
if (!invoke) throw new Error("Device Agent requires the native desktop runtime");

function log(message) {
  void invoke("frontend_report_error", { message: `[agent] ${message}` }).catch(() => {});
}
log("script started");

const CLIENT_ID_KEY = "emilia.device-agent.id.v1";
const deviceId = localStorage.getItem(CLIENT_ID_KEY) || globalThis.crypto?.randomUUID?.() || `agent-${Date.now()}`;
localStorage.setItem(CLIENT_ID_KEY, deviceId);

const agent = new DeviceControlAgent({
  deviceId,
  deviceName: defaultClientName(navigator.platform),
  invoke,
});

let lastConnectionState = {
  state: "offline",
  label: "离线",
  message: "",
  serverName: "",
  transport: "",
  retryInMs: 0,
  transient: true,
};

function publishConnectionState() {
  void events?.emit?.("companion:agent-state", lastConnectionState);
}

async function syncPermissions() {
  const permissions = await invoke("device_get_permissions");
  saveDevicePermissions(permissions, localStorage);
  return permissions;
}

const connection = new CompanionConnectionClient({
  // The relay identity must exactly match the device id advertised below.
  // Core deliberately rejects announcements that claim a different identity.
  clientId: deviceId,
  onReady({ send }) {
    log("connection ready; announcing capabilities");
    void agent.attach(send);
  },
  onState({ state, label, message, serverName, transport, retryInMs, transient }) {
    log(`connection state=${state} label=${label || ""}${message ? ` detail=${message}` : ""}`);
    lastConnectionState = {
      state,
      label: label || "离线",
      message: message || "",
      serverName: serverName || lastConnectionState.serverName || "",
      transport: transport || lastConnectionState.transport || "",
      retryInMs: Number.isFinite(retryInMs) ? retryInMs : 0,
      transient: transient !== false,
    };
    publishConnectionState();
  },
  onEvent(event) {
    if (event.type === "device.command") void agent.handle(event);
    else {
      if (event.type === "voice.audio.begin" || event.type === "voice.audio.end") {
        log(`[voice] received ${event.type}${event.type === "voice.audio.begin" ? ` chunks=${Number(event.total) || 0}` : ""}`);
      }
      void events?.emit?.("companion:transport-event", event);
    }
  },
});

async function connectSavedProfile() {
  const profile = await loadPersistentConnectionProfile({ platform: navigator.platform });
  await syncPermissions();
  if (!profile) {
    log("no saved connection profile");
    return;
  }
  agent.deviceName = profile.name || defaultClientName(navigator.platform);
  log(`secure profile loaded mode=${profile.mode || "direct"}`);
  connection.connect(profile);
}

await events?.listen?.("companion:connection-profile-updated", () => { void connectSavedProfile(); });
await events?.listen?.("companion:agent-state-request", publishConnectionState);
await events?.listen?.("companion:device-permissions-updated", async () => {
  await syncPermissions();
  void agent.announce();
});
await events?.listen?.("companion:transport-chat-send", ({ payload }) => {
  try { connection.sendChat(payload?.text); }
  catch (error) { void events?.emit?.("companion:transport-error", { requestId: payload?.requestId, error: error instanceof Error ? error.message : String(error) }); }
});
await events?.listen?.("companion:transport-file-send", ({ payload }) => {
  try { connection.sendFileToQq(payload?.path, payload?.requestId); }
  catch (error) { void events?.emit?.("companion:transport-error", { requestId: payload?.requestId, error: error instanceof Error ? error.message : String(error) }); }
});
await events?.listen?.("companion:transport-task-command", ({ payload }) => {
  try { connection.sendTaskCommand(payload?.action, payload?.taskId, payload?.requestId); }
  catch (error) { void events?.emit?.("companion:task-result", { requestId: payload?.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }); }
});
await connectSavedProfile();
window.dispatchEvent(new CustomEvent("companion:ready"));

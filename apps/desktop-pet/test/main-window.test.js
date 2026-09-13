import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("desktop app declares separate pet, main, and device-agent windows", async () => {
  const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.deepEqual(config.app.windows.map(({ label }) => label), ["pet", "main", "agent"]);
  const pet = config.app.windows.find(({ label }) => label === "pet");
  const main = config.app.windows.find(({ label }) => label === "main");
  const agent = config.app.windows.find(({ label }) => label === "agent");
  assert.equal(pet.transparent, true);
  assert.equal(pet.alwaysOnTop, true);
  assert.equal(main.url, "main.html");
  assert.equal(main.transparent, false);
  assert.equal(main.visible, false);
  assert.equal(agent.url, "agent.html");
  assert.equal(agent.visible, false);
  const capability = JSON.parse(await readFile(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
  assert.ok(capability.windows.includes("agent"));
});

test("Windows installer bundles and installs a portable Product Core", async () => {
  const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.windows.conf.json", import.meta.url), "utf8"));
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const coreLauncher = await readFile(new URL("../../../scripts/windows/start-core-service.ps1", import.meta.url), "utf8");
  const installer = await readFile(new URL("../../../scripts/install-bundled-core-windows.ps1", import.meta.url), "utf8");
  assert.deepEqual(config.bundle.targets, ["nsis"]);
  assert.equal(config.bundle.resources["../../../.build/r3/"], "core-runtime/");
  assert.match(config.bundle.windows.nsis.installerHooks, /hooks\.nsh$/);
  assert.match(rust, /directory\.join\("core-runtime"\)/);
  assert.doesNotMatch(rust, /C:\\Users\\zhyje\\personal-companion\\scripts/);
  assert.match(coreLauncher, /node\\node\.exe/);
  assert.match(coreLauncher, /EMILIA_ENV_PATH/);
  assert.match(installer, /COMPANION_BRIDGE_ENABLED=true/);
  assert.match(installer, /install-core-task-windows\.ps1/);
  assert.match(installer, /install-host-agent-task-windows\.ps1/);
});

test("macOS client ships as a DMG", async () => {
  const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.deepEqual(config.bundle.targets, ["dmg"]);
});

test("main window exposes every planned control-center section", async () => {
  const html = await readFile(new URL("../src/main.html", import.meta.url), "utf8");
  for (const page of ["chat", "tasks", "files", "devices", "core", "memory", "proactive", "appearance", "settings"]) {
    assert.match(html, new RegExp(`data-page-panel=["']${page}["']`));
  }
  assert.match(html, /data-page=["']core["']/);
});

test("Core page manages paired devices without exposing pairing secrets", async () => {
  const html = await readFile(new URL("../src/main.html", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const id of ["core-paired-devices-list", "core-paired-devices-refresh", "core-paired-devices-result"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(main, /core_list_paired_devices/);
  assert.match(main, /core_revoke_paired_device/);
  assert.match(main, /撤销访问/);
  assert.match(rust, /fn core_list_paired_devices/);
  assert.match(rust, /fn core_revoke_paired_device/);
});

test("settings guide supports both model APIs plus LAN and private-relay connection codes", async () => {
  const html = await readFile(new URL("../src/main.html", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(html, /首次配置/);
  assert.match(html, /id=["']agent-setup-card["']/);
  assert.match(html, /id=["']agent-setup-form["']/);
  assert.match(html, /id=["']roleplay-setup-form["']/);
  assert.match(html, /id=["']qq-setup-form["']/);
  assert.match(html, /id=["']relay-setup-form["']/);
  assert.match(html, /id=["']core-relay-code-create["']/);
  assert.doesNotMatch(html, /configure-agent-windows\.ps1/);
  assert.match(main, /invitation\.mode === "relay"/);
  assert.match(main, /core_configure_agent/);
  assert.match(main, /core_configure_roleplay/);
  assert.match(main, /core_configure_qq/);
  assert.match(main, /core_configure_relay/);
  assert.match(main, /core_create_relay_connection_code/);
  assert.match(rust, /fn core_create_relay_connection_code/);
  assert.match(rust, /fn core_agent_setup_status/);
  assert.match(rust, /fn core_configure_agent/);
  assert.match(rust, /fn core_roleplay_setup_status/);
  assert.match(rust, /fn core_configure_roleplay/);
  assert.match(rust, /fn core_qq_setup_status/);
  assert.match(rust, /fn core_configure_qq/);
  assert.match(rust, /fn core_configure_relay/);
});

test("voice is an explicitly optional host module", async () => {
  const html = await readFile(new URL("../src/main.html", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(html, /艾米莉亚语音（可选模块）/);
  assert.match(html, /id=["']voice-module-toggle["']/);
  assert.match(main, /voice_set_module_enabled/);
  assert.match(rust, /fn voice_module_status/);
  assert.match(rust, /fn voice_set_module_enabled/);
});

test("portrait can be hidden while quick chat and controls remain available", async () => {
  const petHtml = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const pet = await readFile(new URL("../src/pet.js", import.meta.url), "utf8");
  const mainHtml = await readFile(new URL("../src/main.html", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(petHtml, /id=["']portrait-hide["']/);
  assert.match(petHtml, /id=["']app-quit["']/);
  assert.match(petHtml, /id=["']quick-chat-form["']/);
  assert.match(petHtml, /id=["']mini-drag-handle["']/);
  assert.match(petHtml, /data-tauri-drag-region/);
  assert.match(petHtml, /class=["']pet-controls["']/);
  assert.match(pet, /set_pet_portrait_hidden/);
  assert.match(pet, /pet_portrait_is_hidden/);
  assert.match(mainHtml, /id=["']main-show-portrait["']/);
  assert.match(mainHtml, /id=["']main-quit-app["']/);
  assert.match(main, /quit_application/);
  assert.match(rust, /fn set_pet_portrait_hidden/);
  assert.doesNotMatch(rust, /resize_at_bottom_right\(&window, 340\.0, 108\.0\)/);
  assert.match(rust, /place_at_bottom_right\(&window\)/);
  assert.doesNotMatch(rust, /portrait hidden; chat window retained/);
  assert.match(rust, /fn quit_application/);
});

test("pet and main window use acknowledged chat events", async () => {
  const pet = await readFile(new URL("../src/pet.js", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(pet, /companion:main-chat-send-result/);
  assert.match(main, /pendingChatRequest/);
  assert.match(main, /companion:main-request-snapshot/);
  assert.match(main, /function clearPendingChat/);
  assert.match(main, /消息仍未确认；连接可能正在恢复/);
});

test("task center uses structured encrypted transport events", async () => {
  const html = await readFile(new URL("../src/main.html", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const agent = await readFile(new URL("../src/agent.js", import.meta.url), "utf8");
  assert.match(html, /id=["']task-list["']/);
  assert.match(main, /companion:transport-task-command/);
  assert.match(main, /companion:task-result/);
  assert.match(agent, /sendTaskCommand/);
});

test("the hidden device agent owns the only persistent Core transport", async () => {
  const pet = await readFile(new URL("../src/pet.js", import.meta.url), "utf8");
  const agent = await readFile(new URL("../src/agent.js", import.meta.url), "utf8");
  assert.doesNotMatch(pet, /new CompanionConnectionClient/);
  assert.match(agent, /new CompanionConnectionClient/);
  assert.match(agent, /clientId: deviceId/);
  assert.doesNotMatch(agent, /clientId: `\$\{deviceId\}-control`/);
  assert.match(pet, /companion:transport-chat-send/);
  assert.match(agent, /companion:transport-chat-send/);
  assert.match(agent, /companion:agent-state-request/);
});

test("a closed main window can be recreated without keeping the app alive", async () => {
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(rust, /WebviewWindowBuilder::new\(&app, "main"/);
  assert.doesNotMatch(rust, /api\.prevent_close\(\)/);
});

test("file center supports navigation, search, preview, reveal, and Core handoff", async () => {
  const html = await readFile(new URL("../src/main.html", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const id of ["file-search-form", "file-breadcrumbs", "file-entry-list", "file-preview-body", "file-reveal-button", "file-ask-button", "file-send-qq-button", "file-send-status"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(main, /device_list_directory/);
  assert.match(main, /device_search_files/);
  assert.match(main, /device_read_text_file/);
  assert.match(main, /device_read_image_preview/);
  assert.match(main, /sendMainChat/);
  assert.match(main, /companion:main-file-send/);
  assert.match(rust, /fn device_reveal_path/);
  assert.match(rust, /fn device_read_binary_file/);
});

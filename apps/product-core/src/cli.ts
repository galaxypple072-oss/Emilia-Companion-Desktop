import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../qq-gateway/src/config.ts";
import { loadDotEnv } from "../../qq-gateway/src/env.ts";
import { loadAgentConfig, OpenAICompatibleAgent, type AgentAdapter, type AgentConfig } from "./agent.ts";
import { loadProductCoreConfig, parseDelay } from "./config.ts";
import { ProductCoreRuntime } from "./runtime.ts";
import { CompanionBridgeServer, loadCompanionBridgeConfig } from "./companion-bridge.ts";
import { CompositeCompanionEndpoint } from "./companion-endpoint.ts";
import { RelayCompanionEndpoint, loadCompanionRelayConfig } from "./relay-companion-endpoint.ts";
import { installCoreFileLogging } from "./logger.ts";
import { ProductStore } from "./store.ts";
import { loadEmailConfig, SmtpEmailSender } from "./email.ts";
import { HarnessAgentAdapter } from "./harness-agent.ts";
import { DeepSeekVisionAdapter, loadVisionConfig } from "./vision.ts";
import { DeepSeekMemoryExtractor } from "./memory.ts";
import { loadAllowedRoots, ScopedFileService } from "../../file-mcp/src/file-service.ts";
import { loadDiscoveryConfig } from "./discovery.ts";
import { loadWeatherConfig } from "./weather.ts";
import { EmailTriageService } from "./email-inbox-triage.ts";
import { ImapInboxReader, loadImapInboxConfig } from "./imap-inbox.ts";
import { ConversationPolicyService, finalBehaviorInstruction, reviewConversationReply } from "./conversation-policy.ts";
import { EMILIA_CHARACTER_PROMPT, EMILIA_SYSTEM_PROMPT } from "./persona.ts";
import { createRoleplayAgent, loadRoleplayConfig, RoleplayRoutingAgent } from "./roleplay-agent.ts";
import { ReferenceEpisodePlanner } from "./reference-character.ts";
import { DeviceControlRouter } from "./device-control-router.ts";
import { DeviceControlApiServer, loadDeviceControlApiConfig } from "./device-control-api.ts";
import { FallbackVoiceSynthesizer, VoiceClient, loadVoiceClientConfig } from "./voice-client.ts";
import { RuntimeNodeRegistry } from "./runtime-node-registry.ts";
import { OneBotClient } from "../../qq-gateway/src/onebot-client.ts";
import { SplitQqClient } from "./qq-client.ts";
import { createConnectionCode } from "../../../packages/companion-relay-protocol/src/index.js";
import { PairingRegistry } from "./pairing-registry.ts";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function ownerQQ(allowed: ReadonlySet<string>): string {
  if (allowed.size !== 1) throw new Error("Product Core v0.1 requires exactly one owner QQ");
  return [...allowed][0];
}

function createAgent(config: AgentConfig | null, projectRoot: string): AgentAdapter | null {
  if (!config) return null;
  return config.mode === "harness"
    ? new HarnessAgentAdapter({
        projectRoot,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        timeoutMs: Math.max(config.timeoutMs, 180_000),
      })
    : new OpenAICompatibleAgent(config);
}

function createCompanionAgent(config: AgentConfig | null, projectRoot: string): AgentAdapter | null {
  const primary = createAgent(config, projectRoot);
  if (!primary) return null;
  const roleplay = createRoleplayAgent(loadRoleplayConfig());
  return roleplay ? new RoleplayRoutingAgent(primary, roleplay, new ReferenceEpisodePlanner(createPlanningAgent(config))) : primary;
}

function createPlanningAgent(config: AgentConfig | null): AgentAdapter | null {
  return config ? new OpenAICompatibleAgent({
    ...config,
    mode: "direct",
    model: process.env.CONVERSATION_POLICY_MODEL?.trim() || config.model,
    maxTokens: 300,
    temperature: 0.1,
    contextMessages: 2,
    thinking: "disabled",
  }) : null;
}

function createConversationPolicy(config: AgentConfig | null): ConversationPolicyService {
  return new ConversationPolicyService(createPlanningAgent(config));
}

function usage(): string {
  return `Usage:
  npm run core:init
  npm run core:run
  npm run core:status
  npm run core:connection-code -- --url <ws://LAN-IP:8765>
  npm run core:relay-connection-code
  npm run core:paired-devices
  npm run core:revoke-device -- --id <device-id>
  npm run core:send -- --text <message>
  npm run core:remind -- --in <30s|10m|2h|1d> --text <message>
  npm run core:remind -- --at <ISO-8601> --text <message>
  npm run core:inbox -- --limit <count>
  npm run core:actions -- --limit <count>
  npm run agent:verify
  npm run roleplay:verify
  npm run vision:verify
  npm run memory:verify
  npm run tools:verify
  npm run dialogue:verify
  npm run email:verify
  npm run email-inbox:verify`;
}

async function main(): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  loadDotEnv(resolve(projectRoot, ".env"));
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }

  const oneBot = loadConfig();
  const core = loadProductCoreConfig();
  const agentConfig = loadAgentConfig();
  const roleplayConfig = loadRoleplayConfig();
  const visionConfig = loadVisionConfig(agentConfig);
  const emailConfig = loadEmailConfig();
  const imapInboxConfig = loadImapInboxConfig(process.env, emailConfig);
  const discoveryConfig = loadDiscoveryConfig();
  const weatherConfig = loadWeatherConfig();
  const store = new ProductStore(core.databasePath);
  if (emailConfig) store.upsertContact("老板", emailConfig.bossEmail);
  try {
    if (command === "init") {
      console.log(JSON.stringify({ initialized: true, database: core.databasePath }, null, 2));
      return;
    }
    if (command === "status") {
      console.log(JSON.stringify({
        database: core.databasePath,
        agent: agentConfig
          ? { configured: true, mode: agentConfig.mode, base_url: agentConfig.baseUrl, model: agentConfig.model }
          : { configured: false },
        roleplay: roleplayConfig
          ? { configured: true, base_url: roleplayConfig.baseUrl, model: roleplayConfig.model, routes: ["casual", "vent", "emotional"] }
          : { configured: false },
        email: emailConfig
          ? { configured: true, host: emailConfig.host, recipient: "<configured>" }
          : { configured: false },
        email_inbox: imapInboxConfig
          ? { configured: true, host: imapInboxConfig.host, mailbox: imapInboxConfig.mailbox, poll_seconds: imapInboxConfig.pollIntervalMs / 1000 }
          : { configured: false },
        quiet_mode: store.getState("quiet_mode") === "on",
        discovery: {
          configured: discoveryConfig.enabled,
          override: store.getState("discovery_mode") ?? "default",
          interests: store.listInterests().length,
          daily_share_limit: discoveryConfig.dailyShareLimit,
          minimum_check_interval_hours: discoveryConfig.minimumCheckIntervalMs / 3_600_000,
        },
        weather: {
          configured: weatherConfig.enabled,
          override: store.getState("weather_mode") ?? "default",
          location: store.getState("weather_location") ?? null,
          daily_alert_limit: weatherConfig.dailyAlertLimit,
        },
        dialogue_policy: {
          persona_version: store.getState("persona_version"),
          persona_epoch_at: store.getState("persona_epoch_at") ? new Date(Number(store.getState("persona_epoch_at"))).toISOString() : null,
          style_feedback: store.listStyleFeedback(1000).length,
          recent_metrics: store.dialoguePolicySummary(50),
        },
        stickers: {
          learned: store.listStickers(100).length,
          ready: store.canUseSticker(),
          cooldown_minutes: 10,
        },
        ...store.summary(),
      }, null, 2));
      return;
    }
    if (command === "connection-code") {
      const bridge = loadCompanionBridgeConfig();
      if (!bridge) throw new Error("Companion Bridge is not enabled on this Core");
      const url = option(args, "--url");
      if (!url) throw new Error("connection-code requires --url <ws://LAN-IP:8765>");
      const control = loadDeviceControlApiConfig();
      if (!control) throw new Error("Core pairing control is unavailable");
      const response = await fetch(`http://${control.host}:${control.port}/v1/pairing/invitations`, { method: "POST", headers: { authorization: `Bearer ${control.token}`, "content-type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error(`Core pairing invitation could not be created (HTTP ${response.status}: ${(await response.text()).slice(0, 120)})`);
      const invitation = await response.json() as { token?: string; expiresAt?: number };
      if (!invitation.token || !Number.isFinite(invitation.expiresAt)) throw new Error("Core pairing invitation is malformed");
      console.log(JSON.stringify({
        mode: "direct",
        server_name: bridge.serverName,
        expires_at: invitation.expiresAt,
        code: createConnectionCode({ mode: "direct", url, token: invitation.token }),
      }));
      return;
    }
    if (command === "relay-connection-code") {
      const relay = loadCompanionRelayConfig();
      if (!relay) throw new Error("Private relay is not enabled on this Core");
      console.log(JSON.stringify({
        mode: "relay",
        server_name: relay.serverName,
        code: createConnectionCode({ mode: "relay", url: relay.url, pairingCode: relay.pairingCode }),
      }));
      return;
    }
    if (command === "paired-devices" || command === "revoke-device") {
      const control = loadDeviceControlApiConfig();
      if (!control) throw new Error("Core pairing control is unavailable");
      const id = command === "revoke-device" ? option(args, "--id") : undefined;
      if (command === "revoke-device" && !id) throw new Error("revoke-device requires --id <device-id>");
      const response = await fetch(`http://${control.host}:${control.port}/v1/pairing/devices${id ? `/${encodeURIComponent(id)}` : ""}`, { method: id ? "DELETE" : "GET", headers: { authorization: `Bearer ${control.token}` } });
      if (!response.ok) throw new Error(id ? `Paired device was not found (HTTP ${response.status}: ${(await response.text()).slice(0, 120)})` : `Core pairing devices could not be read (HTTP ${response.status}: ${(await response.text()).slice(0, 120)})`);
      console.log(JSON.stringify(await response.json()));
      return;
    }
    if (command === "inbox") {
      const limit = Number(option(args, "--limit") ?? "20");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("--limit must be an integer between 1 and 100");
      }
      console.log(JSON.stringify(store.listInbound(limit).map((row) => ({ ...row, sender_id: "<redacted>" })), null, 2));
      return;
    }
    if (command === "actions") {
      const limit = Number(option(args, "--limit") ?? "20");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit must be an integer between 1 and 100");
      console.log(JSON.stringify(store.listActionAudit(limit), null, 2));
      return;
    }
    if (command === "email-verify") {
      if (!emailConfig) throw new Error("Email is not configured");
      await new SmtpEmailSender(emailConfig).verify();
      console.log(JSON.stringify({ verified: true, host: emailConfig.host, recipient: "<configured>" }, null, 2));
      return;
    }
    if (command === "email-inbox-verify") {
      if (!imapInboxConfig) throw new Error("Incoming email monitoring is not configured");
      const result = await new ImapInboxReader(imapInboxConfig).verify();
      console.log(JSON.stringify({ verified: true, host: imapInboxConfig.host, ...result }, null, 2));
      return;
    }
    if (command === "agent-verify") {
      const agent = createAgent(agentConfig, projectRoot);
      if (!agent) throw new Error("Agent is not configured");
      const reply = await agent.generateReply({
        systemPrompt: "This is a connectivity check. Do not call any tools.",
        messages: [{ role: "user", content: "Reply with exactly OK and nothing else." }],
      });
      console.log(JSON.stringify({ verified: reply.trim() === "OK", reply: reply.trim().slice(0, 100) }, null, 2));
      return;
    }
    if (command === "roleplay-verify") {
      const agent = createRoleplayAgent(roleplayConfig);
      if (!agent) throw new Error("Roleplay model is not configured");
      const reply = await agent.generateReply({
        systemPrompt: [
          EMILIA_CHARACTER_PROMPT,
          "这是现实中的即时聊天。不要写动作旁白；只回复一两句自然短消息，不用问题结尾。",
        ].join("\n\n"),
        messages: [{ role: "user", content: "今天累死了" }],
      });
      console.log(JSON.stringify({ verified: reply.length > 0 && !/[（(*]/u.test(reply), model: roleplayConfig.model, reply }, null, 2));
      return;
    }
    if (command === "dialogue-verify") {
      const agent = createCompanionAgent(agentConfig, projectRoot);
      if (!agent) throw new Error("Agent is not configured");
      const policy = createConversationPolicy(agentConfig);
      const samples = ["老板又给我加活了", "今天累死了", "我刚刚在路边看到一只特别神气的猫"];
      const results = [];
      for (const sample of samples) {
        const plan = await policy.plan(sample, []);
        const draft = await agent.generateReply({
          systemPrompt: EMILIA_SYSTEM_PROMPT,
          messages: [{ role: "user", content: sample }],
          finalInstruction: finalBehaviorInstruction(plan),
        });
        const final = await policy.enforce(draft, plan, sample);
        const valid = reviewConversationReply(final.text, plan).length === 0;
        results.push({ input: sample, intent: plan.intent, move: plan.move, questionBudget: plan.questionBudget, rewritten: final.rewritten, valid, output: final.text });
      }
      console.log(JSON.stringify({ verified: results.every((item) => item.valid), results }, null, 2));
      return;
    }
    if (command === "vision-verify") {
      if (!visionConfig) throw new Error("Vision is not configured");
      // This deterministic 1x1 opaque black PNG requires the model to inspect image content.
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      const reply = await new DeepSeekVisionAdapter(visionConfig).analyze(
        { bytes: png, mediaType: "image/png" },
        "识别图片中唯一像素的颜色。只回复一个中文颜色词，不要解释，也不要猜测测试意图。",
      );
      console.log(JSON.stringify({ verified: /黑/u.test(reply), model: visionConfig.model, reply: reply.trim().slice(0, 100) }, null, 2));
      return;
    }
    if (command === "memory-verify") {
      if (!agentConfig) throw new Error("Agent is not configured");
      const extractor = new DeepSeekMemoryExtractor(agentConfig, process.env.MEMORY_MODEL?.trim() || agentConfig.model);
      const memories = await extractor.extract("这是连通测试：我的老板偏好简洁的邮件表达。请提取其中稳定且有用的记忆。");
      console.log(JSON.stringify({ verified: memories.length > 0, count: memories.length, kinds: memories.map((memory) => memory.kind) }, null, 2));
      return;
    }
    if (command === "tools-verify") {
      const agent = createAgent(agentConfig, projectRoot);
      if (!agent) throw new Error("Agent is not configured");
      const filesReply = await agent.generateReply({
        systemPrompt: "Connectivity test. You must call the file MCP list_allowed_folders tool. Do not call mutation tools.",
        messages: [{ role: "user", content: "List the allowed folders in one short line." }],
      });
      const webReply = await agent.generateReply({
        systemPrompt: "Connectivity test. You must call web_search and cite the resulting URL. Do not use other tools.",
        messages: [{ role: "user", content: "Search for the official DeepSeek Harness GitHub repository and give only its URL." }],
      });
      const inboxReply = await agent.generateReply({
        systemPrompt: "Connectivity test. You must call the email MCP list_recent_emails tool with limit 1. If the tool succeeds, reply exactly INBOX_OK. Never reveal any email metadata or content.",
        messages: [{ role: "user", content: "Verify read-only inbox access." }],
      });
      console.log(JSON.stringify({
        filesVerified: /D:\\(?:work|study|learning|pictures|travel)/iu.test(filesReply),
        webVerified: /https?:\/\//u.test(webReply),
        inboxVerified: inboxReply.trim() === "INBOX_OK",
        filesReply: filesReply.slice(0, 500),
        webReply: webReply.slice(0, 500),
        inboxReply: inboxReply.slice(0, 100),
      }, null, 2));
      return;
    }
    if (command === "send" || command === "remind") {
      const text = option(args, "--text");
      if (!text) throw new Error(`${command} requires --text <message>`);
      let dueAt = Date.now();
      if (command === "remind") {
        const delayValue = option(args, "--in");
        const atValue = option(args, "--at");
        if (Boolean(delayValue) === Boolean(atValue)) {
          throw new Error("remind requires exactly one of --in or --at");
        }
        dueAt = delayValue ? Date.now() + parseDelay(delayValue) : Date.parse(atValue!);
        if (!Number.isFinite(dueAt) || dueAt <= Date.now()) {
          throw new Error("Reminder time must be a valid future time");
        }
      }
      const id = store.enqueue({ recipientId: ownerQQ(oneBot.allowedQQs), body: text, dueAt });
      console.log(JSON.stringify({ queued: true, id, due_at: new Date(dueAt).toISOString() }, null, 2));
      return;
    }
    if (command === "run") {
      const logPath = installCoreFileLogging(core.dataDir);
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      process.once("SIGTERM", () => controller.abort());
      console.log(`[product-core] file logging enabled: ${logPath}`);
      const agent = createCompanionAgent(agentConfig, projectRoot);
      const vision = visionConfig ? new DeepSeekVisionAdapter(visionConfig) : null;
      const memoryExtractor = agentConfig && process.env.MEMORY_ENABLED?.trim().toLowerCase() !== "false"
        ? new DeepSeekMemoryExtractor(agentConfig, process.env.MEMORY_MODEL?.trim() || agentConfig.model)
        : null;
      const fileRoots = loadAllowedRoots();
      const fileService = fileRoots.length ? await ScopedFileService.create(fileRoots) : null;
      const imapInbox = imapInboxConfig
        ? { reader: new ImapInboxReader(imapInboxConfig), config: imapInboxConfig }
        : null;
      const emailTriageAgent = agentConfig
        ? new OpenAICompatibleAgent({
            ...agentConfig,
            mode: "direct",
            model: process.env.EMAIL_TRIAGE_MODEL?.trim() || agentConfig.model,
            maxTokens: 500,
            temperature: 0.1,
            contextMessages: 2,
            thinking: "disabled",
          })
        : null;
      // Translation must bypass the companion/roleplay router: its examples and
      // character constraints can make an otherwise literal Japanese request
      // return Chinese, which correctly causes the local Japanese TTS to skip.
      const voiceTranslator = agentConfig
        ? new OpenAICompatibleAgent({
            ...agentConfig,
            mode: "direct",
            model: process.env.VOICE_TRANSLATION_MODEL?.trim() || agentConfig.model,
            maxTokens: 300,
            temperature: 0.1,
            contextMessages: 2,
            thinking: "disabled",
          })
        : null;
      const bridgeConfig = loadCompanionBridgeConfig();
      const relayConfig = loadCompanionRelayConfig();
      const devices = new DeviceControlRouter();
      const pairing = new PairingRegistry(store);
      const runtimeNodes = new RuntimeNodeRegistry();
      const useQqWorker = process.env.EMILIA_QQ_CORE_ROUTING?.trim().toLowerCase() === "true";
      const voiceConfig = loadVoiceClientConfig();
      const deviceApiConfig = loadDeviceControlApiConfig();
      let runtime!: ProductCoreRuntime;
      const relayEndpoint = relayConfig
        ? new RelayCompanionEndpoint(relayConfig, (request) => runtime.handleCompanionChat(request), devices, (request) => runtime.handleCompanionFileSend(request), (request) => runtime.handleCompanionTask(request), (response) => runtime.synthesizeCompanionVoice(response), runtimeNodes, (event) => runtime.handleQqWorkerInbound(event))
        : null;
      const voice = new FallbackVoiceSynthesizer([relayEndpoint, voiceConfig ? new VoiceClient(voiceConfig) : null]);
      const qq = useQqWorker && relayEndpoint ? new SplitQqClient(relayEndpoint, new OneBotClient(oneBot)) : null;
      const companionEndpoints = [
        bridgeConfig ? new CompanionBridgeServer(bridgeConfig, (request) => runtime.handleCompanionChat(request), devices, (request) => runtime.handleCompanionFileSend(request), (request) => runtime.handleCompanionTask(request), (response) => runtime.synthesizeCompanionVoice(response), pairing) : null,
        relayEndpoint,
        deviceApiConfig ? new DeviceControlApiServer(deviceApiConfig, devices, vision, visionConfig?.maxImageBytes, pairing) : null,
      ].filter((endpoint) => endpoint !== null);
      const companionBridge = companionEndpoints.length ? new CompositeCompanionEndpoint(companionEndpoints) : null;
      runtime = new ProductCoreRuntime(oneBot, core, store, {
        agent,
        vision,
        visionMaxImageBytes: visionConfig?.maxImageBytes,
        memoryExtractor,
        fileService,
        discovery: discoveryConfig,
        weather: weatherConfig,
        contextMessages: agentConfig?.contextMessages,
        email: emailConfig ? new SmtpEmailSender(emailConfig) : null,
        imapInbox,
        emailTriage: imapInbox && emailTriageAgent ? new EmailTriageService(emailTriageAgent) : null,
        conversationPolicy: createConversationPolicy(agentConfig),
        companionBridge,
        devices,
        voice,
        voiceTranslator,
        qq,
        externalQqInbound: Boolean(qq),
      });
      await runtime.run(controller.signal);
      return;
    }
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[product-core] ${message}`);
  process.exitCode = 1;
});

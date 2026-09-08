import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { OneBotClient } from "../../qq-gateway/src/onebot-client.ts";
import { parseOneBotMessage, type OneBotImageReference } from "../../qq-gateway/src/onebot-images.ts";
import type { OneBotConfig } from "../../qq-gateway/src/config.ts";
import type { AgentAdapter, AgentRequest } from "./agent.ts";
import { handleCoreCommand } from "./commands.ts";
import { handleDeviceCommand } from "./device-command.ts";
import type { DeviceControlRouter } from "./device-control-router.ts";
import { handleEmailInstruction } from "./email-command.ts";
import type { EmailSender } from "./email.ts";
import type { ProductCoreConfig } from "./config.ts";
import { EMILIA_SYSTEM_PROMPT } from "./persona.ts";
import { ProductStore } from "./store.ts";
import { detectImageMediaType, prepareVisionImage, type VisionAdapter } from "./vision.ts";
import { ReplyScheduler } from "./reply-scheduler.ts";
import { memoryContext, type MemoryExtractor } from "./memory.ts";
import { formatQqReply, qqBubbleOffsets } from "./chat-format.ts";
import type { ScopedFileService } from "../../file-mcp/src/file-service.ts";
import { DiscoveryEngine, type DiscoveryConfig } from "./discovery.ts";
import { WeatherEngine, type WeatherConfig } from "./weather.ts";
import { EmailTriageService, formatImportantEmail } from "./email-inbox-triage.ts";
import { ImapInboxReader, type ImapCursor, type ImapInboxConfig } from "./imap-inbox.ts";
import { ConversationPolicyService, detectStyleFeedback, finalBehaviorInstruction } from "./conversation-policy.ts";
import { extractStickerDirective, isStickerSendRequest, isStickerTeachingCaption, parseStickerOutboxBody, StickerLibrary, stickerOutboxBody } from "./stickers.ts";
import { WebImageService } from "./web-image.ts";
import type { CompanionChatRequest, CompanionChatResponse, CompanionFileSendRequest, CompanionFileSendResponse, CompanionTaskRequest, CompanionTaskResponse } from "./companion-bridge.ts";
import { decodeDeviceBinary } from "./device-control-api.ts";
import type { CompanionEndpoint } from "./companion-endpoint.ts";
import { AffectEngine } from "./affect.ts";
import { isLikelyQqSticker, isOnlyEmojiMessage, replyQuietWindowMs } from "./turn-assembly.ts";
import { fallbackTurnFrame, groundingFallback, validateStructuredGrounding } from "./structured-character.ts";
import type { ConversationPlan } from "./conversation-policy.ts";
import { REFERENCE_NO_REPLY } from "./reference-character.ts";
import { companionTimeContext } from "./time-context.ts";
import type { VoiceSynthesizer } from "./voice-client.ts";
import type { QqClient } from "./qq-client.ts";

interface ScheduledAgentReply {
  request: AgentRequest;
  extractionText: string;
  sourceMessageId: string | null;
}

function finalCharacterGrounding(
  text: string,
  request: AgentRequest,
  plan: ConversationPlan,
  userText: string,
): { text: string; rewritten: boolean; violations: string[] } {
  const frame = fallbackTurnFrame(request.messages, plan, request.grounding?.verifiedMemories ?? []);
  if (!["casual", "vent", "emotional"].includes(plan.intent) && frame.hardConstraint.kind === "none") {
    return { text, rewritten: false, violations: [] };
  }
  const violations = validateStructuredGrounding(text, frame, userText);
  if (violations.length === 0) return { text, rewritten: false, violations: [] };
  return { text: groundingFallback(text, frame, violations), rewritten: true, violations };
}

const PERSONA_VERSION = "emilia-canonical-companion-v3";
const STICKER_TEACHING_WINDOW_MS = 30 * 60_000;

interface PrivateMessageEvent {
  post_type: "message";
  message_type: "private";
  user_id: number | string;
  message_id?: number | string;
  raw_message?: string;
  message?: unknown;
  time?: number;
}

function privateMessage(value: unknown): PrivateMessageEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.post_type !== "message" || event.message_type !== "private") return null;
  return event as unknown as PrivateMessageEvent;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function naturalVariant(options: readonly string[], random: () => number = Math.random): string {
  return options[Math.min(options.length - 1, Math.floor(random() * options.length))];
}

const STICKER_SAVED_REPLIES = [
  "嗯，收好了。",
  "好，这张我记下了。",
  "收到，放进我的表情库了。",
  "唔，这张以后用得上。",
] as const;

export class ProductCoreRuntime {
  private readonly oneBot: OneBotConfig;
  private readonly core: ProductCoreConfig;
  private readonly store: ProductStore;
  private readonly client: QqClient;
  private readonly externalQqInbound: boolean;
  private readonly agent: AgentAdapter | null;
  private readonly contextMessages: number;
  private readonly ownerQQ: string;
  private readonly email: EmailSender | null;
  private readonly vision: VisionAdapter | null;
  private readonly visionMaxImageBytes: number;
  private readonly replyScheduler: ReplyScheduler<ScheduledAgentReply> | null;
  private readonly memoryExtractor: MemoryExtractor | null;
  private readonly fileService: ScopedFileService | null;
  private readonly devices: DeviceControlRouter | null;
  private readonly discovery: DiscoveryEngine | null;
  private readonly discoveryConfig: DiscoveryConfig | null;
  private readonly weather: WeatherEngine | null;
  private readonly weatherConfig: WeatherConfig | null;
  private readonly imapInbox: { reader: ImapInboxReader; config: ImapInboxConfig } | null;
  private readonly emailTriage: EmailTriageService | null;
  private readonly conversationPolicy: ConversationPolicyService;
  private readonly stickers: StickerLibrary;
  private readonly webImages: WebImageService;
  private readonly companionBridge: CompanionEndpoint | null;
  private readonly affect: AffectEngine;
  private readonly personaEpoch: number;
  private readonly voice: VoiceSynthesizer | null;
  private readonly voiceTranslator: AgentAdapter | null;
  private inboundChain: Promise<void> = Promise.resolve();
  private companionChain: Promise<void> = Promise.resolve();

  constructor(
    oneBot: OneBotConfig,
    core: ProductCoreConfig,
    store: ProductStore,
    options: { agent?: AgentAdapter | null; contextMessages?: number; email?: EmailSender | null; vision?: VisionAdapter | null; visionMaxImageBytes?: number; memoryExtractor?: MemoryExtractor | null; fileService?: ScopedFileService | null; discovery?: DiscoveryConfig | null; weather?: WeatherConfig | null; imapInbox?: { reader: ImapInboxReader; config: ImapInboxConfig } | null; emailTriage?: EmailTriageService | null; conversationPolicy?: ConversationPolicyService | null; companionBridge?: CompanionEndpoint | null; devices?: DeviceControlRouter | null; voice?: VoiceSynthesizer | null; voiceTranslator?: AgentAdapter | null; qq?: QqClient; externalQqInbound?: boolean } = {},
  ) {
    this.oneBot = oneBot;
    this.core = core;
    this.store = store;
    this.client = options.qq ?? new OneBotClient(oneBot);
    this.externalQqInbound = options.externalQqInbound ?? false;
    this.agent = options.agent ?? null;
    this.contextMessages = options.contextMessages ?? 20;
    this.email = options.email ?? null;
    this.vision = options.vision ?? null;
    this.visionMaxImageBytes = options.visionMaxImageBytes ?? 8 * 1024 * 1024;
    this.memoryExtractor = options.memoryExtractor ?? null;
    this.fileService = options.fileService ?? null;
    this.devices = options.devices ?? null;
    this.discoveryConfig = options.discovery ?? null;
    this.weatherConfig = options.weather ?? null;
    this.imapInbox = options.imapInbox ?? null;
    this.emailTriage = options.emailTriage ?? null;
    this.conversationPolicy = options.conversationPolicy ?? new ConversationPolicyService();
    this.stickers = new StickerLibrary(this.store, join(this.core.dataDir, "stickers"));
    this.webImages = new WebImageService();
    this.companionBridge = options.companionBridge ?? null;
    this.affect = new AffectEngine(this.store);
    this.personaEpoch = this.store.ensurePersonaEpoch(PERSONA_VERSION);
    this.voice = options.voice ?? null;
    this.voiceTranslator = options.voiceTranslator ?? null;
    if (oneBot.allowedQQs.size !== 1) {
      throw new Error("Product Core v0.1 requires exactly one owner QQ");
    }
    this.ownerQQ = [...oneBot.allowedQQs][0];
    this.discovery = this.agent && this.discoveryConfig
      ? new DiscoveryEngine(this.store, this.ownerQQ, this.agent, this.discoveryConfig)
      : null;
    this.weather = this.agent && this.weatherConfig
      ? new WeatherEngine(this.store, this.ownerQQ, this.agent, this.weatherConfig)
      : null;
    this.replyScheduler = this.agent ? new ReplyScheduler(
      () => {
        const messages = this.store.recentConversation(this.ownerQQ, this.contextMessages, this.personaEpoch);
        const trailingUsers: string[] = [];
        for (let index = messages.length - 1; index >= 0 && messages[index].role === "user"; index -= 1) {
          trailingUsers.unshift(messages[index].content);
        }
        const extractionText = trailingUsers.join("\n").slice(0, 6000);
        const memories = this.store.retrieveMemories(extractionText, 3);
        const context = memoryContext(memories);
        const location = this.store.getState("weather_location");
        const profile = location ? `用户资料：常驻城市或天气地区是“${location}”。涉及天气和本地信息时优先使用它。` : "";
        const timeContext = companionTimeContext(Date.now(), this.store.latestAssistantConversationAt(this.ownerQQ, this.personaEpoch));
        return {
          request: {
            systemPrompt: [EMILIA_SYSTEM_PROMPT, profile, timeContext, context, this.affect.promptContext(this.ownerQQ), this.stickers.promptContext()].filter(Boolean).join("\n\n"),
            messages,
            grounding: { verifiedMemories: memories.map((memory) => memory.content) },
          },
          extractionText,
          sourceMessageId: this.store.latestInboundExternalMessageId(this.ownerQQ),
        };
      },
      async (scheduled, execution) => {
        const recentAssistant = this.store.recentAssistantMessages(this.ownerQQ, 4, this.personaEpoch);
        const plan = await this.conversationPolicy.plan(scheduled.extractionText, recentAssistant);
        if (!execution.isCurrent()) {
          console.log(`[product-core] stale agent reply skipped before generation revision=${execution.revision}`);
          return;
        }
        scheduled.request.finalInstruction = finalBehaviorInstruction(plan, this.store.stylePreferenceContext());
        scheduled.request.conversation = {
          intent: plan.intent,
          move: plan.move,
          questionBudget: plan.questionBudget,
          maxChars: plan.maxChars,
        };
        if (plan.intent !== "task") scheduled.request.signal = execution.signal;
        const draft = await this.agent!.generateReply(scheduled.request);
        if (!execution.isCurrent() && plan.intent !== "task") {
          console.log(`[product-core] stale conversational reply discarded revision=${execution.revision} intent=${plan.intent}`);
          return;
        }
        if (draft.trim() === REFERENCE_NO_REPLY) {
          this.store.recordDialogueAudit({
            sourceMessageId: scheduled.sourceMessageId,
            intent: plan.intent,
            move: "quiet",
            questionBudget: 0,
            maxChars: 0,
            rewritten: false,
            violations: [],
            finalText: "[等待用户继续发送]",
          });
          if (this.memoryExtractor && scheduled.sourceMessageId && scheduled.extractionText) {
            this.store.enqueueMemoryExtraction(scheduled.sourceMessageId, scheduled.extractionText);
          }
          console.log("[product-core] unfinished episode kept silent");
          return;
        }
        const selected = extractStickerDirective(draft);
        const sticker = this.stickers.resolveUsable(selected.stickerId);
        const policyResult = selected.text
          ? await this.conversationPolicy.enforce(selected.text, plan, scheduled.extractionText)
          // A sticker is a garnish, never the entire conversational turn.
          // This also protects against a model returning only [[sticker:...]].
          : { text: sticker ? "嗯，我在听。" : "……", rewritten: Boolean(sticker), violations: sticker ? ["sticker_only_reply"] : [] };
        const finalGrounding = policyResult.text
          ? finalCharacterGrounding(policyResult.text, scheduled.request, plan, scheduled.extractionText)
          : { text: policyResult.text, rewritten: false, violations: [] as string[] };
        const enforced = {
          text: finalGrounding.text,
          rewritten: policyResult.rewritten || finalGrounding.rewritten,
          violations: [...policyResult.violations, ...finalGrounding.violations],
        };
        this.store.recordDialogueAudit({
          sourceMessageId: scheduled.sourceMessageId,
          intent: plan.intent,
          move: plan.move,
          questionBudget: plan.questionBudget,
          maxChars: plan.maxChars,
          rewritten: enforced.rewritten,
          violations: enforced.violations,
          finalText: enforced.text || "[表情包]",
        });
        const chunks = enforced.text ? formatQqReply(enforced.text, scheduled.extractionText) : [];
        const now = Date.now();
        const offsets = qqBubbleOffsets(chunks.length);
        chunks.forEach((body, index) => this.store.enqueue({
          recipientId: this.ownerQQ,
          body,
          dueAt: now + offsets[index],
        }));
        if (sticker) {
          const stickerDueAt = now + (offsets.at(-1) ?? 0) + (chunks.length ? 700 : 0);
          this.store.enqueue({ recipientId: this.ownerQQ, body: stickerOutboxBody(sticker.id), dueAt: stickerDueAt });
        }
        if (this.memoryExtractor && scheduled.sourceMessageId && scheduled.extractionText) {
          this.store.enqueueMemoryExtraction(scheduled.sourceMessageId, scheduled.extractionText);
        }
        console.log(`[product-core] debounced agent reply queued chunks=${chunks.length} sticker=${sticker ? sticker.id : "none"} move=${plan.move} questions=${plan.questionBudget} rewritten=${enforced.rewritten}`);
      },
      (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[product-core] agent request failed: ${detail}`);
        this.store.enqueue({
          recipientId: this.ownerQQ,
          body: "刚才卡住了……这条没处理完",
        });
      },
    ) : null;
  }

  async handleCompanionTask(request: CompanionTaskRequest): Promise<CompanionTaskResponse> {
    if (request.action === "complete") {
      if (!request.taskId) throw new Error("缺少任务 ID");
      this.store.completeTask(request.taskId);
    } else if (request.action === "cancel") {
      if (!request.taskId) throw new Error("缺少任务 ID");
      this.store.cancelTask(request.taskId);
    }
    return { tasks: this.store.listTasks("pending", 100) };
  }

  async run(signal: AbortSignal): Promise<void> {
    const recovered = this.store.recoverInterrupted();
    const recoveredActions = this.store.recoverInterruptedActions();
    const recoveredMemoryJobs = this.store.recoverMemoryExtractions();
    const recoveredIncomingEmails = this.store.recoverIncomingEmails();
    console.log(`[product-core] started; recovered=${recovered}; recoveredActions=${recoveredActions}; recoveredMemoryJobs=${recoveredMemoryJobs}; recoveredIncomingEmails=${recoveredIncomingEmails}; database=${this.core.databasePath}`);
    const runtimeController = new AbortController();
    const stopRuntime = (): void => runtimeController.abort();
    signal.addEventListener("abort", stopRuntime, { once: true });
    if (signal.aborted) runtimeController.abort();
    const runtimeSignal = runtimeController.signal;
    const workers = [
      this.companionBridge?.run(runtimeSignal) ?? Promise.resolve(),
      this.runOutbox(runtimeSignal), this.runActions(runtimeSignal), this.runTaskNotifications(runtimeSignal),
      this.runMemoryExtractions(runtimeSignal), this.runEmailInbox(runtimeSignal), this.runEmailTriage(runtimeSignal),
      this.runDiscovery(runtimeSignal), this.runWeather(runtimeSignal), this.externalQqInbound ? Promise.resolve() : this.runInbound(runtimeSignal),
    ];
    try {
      await Promise.all(workers);
    } finally {
      runtimeController.abort();
      await Promise.allSettled(workers);
      signal.removeEventListener("abort", stopRuntime);
      await this.inboundChain;
      await this.companionChain;
      this.replyScheduler?.flushNow();
      await this.replyScheduler?.waitForIdle();
    }
  }

  handleQqWorkerInbound(event: unknown): void {
    const privateEvent = privateMessage(event);
    if (!privateEvent) return;
    const senderId = String(privateEvent.user_id);
    if (!this.oneBot.allowedQQs.has(senderId)) return;
    this.inboundChain = this.inboundChain.then(() => this.processInbound(privateEvent, senderId)).catch((error) => console.error(`[product-core] worker inbound processing failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  handleCompanionChat(request: CompanionChatRequest): Promise<CompanionChatResponse> {
    let resolve!: (value: CompanionChatResponse) => void;
    let reject!: (reason?: unknown) => void;
    const result = new Promise<CompanionChatResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.companionChain = this.companionChain.then(async () => {
      try {
        resolve(await this.processCompanionChat(request));
      } catch (error) {
        reject(error);
      }
    });
    return result;
  }

  async handleCompanionFileSend(request: CompanionFileSendRequest): Promise<CompanionFileSendResponse> {
    if (!this.devices) throw new Error("Core 尚未启用设备控制");
    const payload = await this.devices.execute(request.clientId, "files.read_binary", { path: request.path }, 180_000);
    const binary = decodeDeviceBinary(payload, 20 * 1024 * 1024);
    const directory = await mkdtemp(join(tmpdir(), "emilia-qq-file-"));
    const localPath = join(directory, binary.name);
    try {
      await writeFile(localPath, binary.bytes, { flag: "wx" });
      const result = await this.client.sendPrivateFile(this.ownerQQ, localPath, binary.name);
      return {
        name: binary.name,
        size: binary.bytes.length,
        sha256: binary.sha256,
        externalId: result.file_id === undefined ? null : String(result.file_id),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async processCompanionChat(request: CompanionChatRequest): Promise<CompanionChatResponse> {
    const sourceMessageId = `desktop:${request.clientId}:${request.requestId}`;
    const inserted = this.store.recordCompanionMessage({
      ownerId: this.ownerQQ,
      clientId: request.clientId,
      externalMessageId: sourceMessageId,
      role: "user",
      content: request.text,
    });
    if (!inserted) throw new Error("Duplicate desktop message");
    this.affect.observeUserMessage(this.ownerQQ, sourceMessageId, request.text);
    for (const feedback of detectStyleFeedback(request.text)) {
      this.store.recordStyleFeedback({ ...feedback, sourceMessageId, targetOutboxId: null });
    }
    const command = handleCoreCommand(request.text, this.store, this.ownerQQ, Date.now(), sourceMessageId);
    if (command.handled) {
      const chunks = command.reply ? formatQqReply(command.reply, request.text) : [];
      chunks.forEach((content, index) => this.store.recordCompanionMessage({
        ownerId: this.ownerQQ,
        clientId: request.clientId,
        externalMessageId: `${sourceMessageId}:assistant:${index}`,
        role: "assistant",
        content,
        occurredAt: Date.now() + index,
      }));
      return { chunks, ...this.affect.expression(this.ownerQQ) };
    }
    if (!this.agent) throw new Error("Agent is not configured");
    const messages = this.store.recentConversation(this.ownerQQ, this.contextMessages, this.personaEpoch);
    const memories = this.store.retrieveMemories(request.text, 8);
    const context = memoryContext(memories);
    const location = this.store.getState("weather_location");
    const profile = location ? `用户资料：常驻城市或天气地区是“${location}”。涉及天气和本地信息时优先使用它。` : "";
    const timeContext = companionTimeContext(Date.now(), this.store.latestAssistantConversationAt(this.ownerQQ, this.personaEpoch));
    const recentAssistant = messages.filter((message) => message.role === "assistant").slice(-4).map((message) => message.content);
    const plan = await this.conversationPolicy.plan(request.text, recentAssistant);
    const agentRequest: AgentRequest = {
      systemPrompt: [EMILIA_SYSTEM_PROMPT, profile, timeContext, context, this.affect.promptContext(this.ownerQQ), this.stickers.promptContext()].filter(Boolean).join("\n\n"),
      messages,
      finalInstruction: finalBehaviorInstruction(plan, this.store.stylePreferenceContext()),
      conversation: { intent: plan.intent, move: plan.move, questionBudget: plan.questionBudget, maxChars: plan.maxChars },
      grounding: { verifiedMemories: memories.map((memory) => memory.content) },
    };
    const draft = await this.agent.generateReply(agentRequest);
    if (draft.trim() === REFERENCE_NO_REPLY) {
      this.store.recordDialogueAudit({
        sourceMessageId,
        intent: plan.intent,
        move: "quiet",
        questionBudget: 0,
        maxChars: 0,
        rewritten: false,
        violations: [],
        finalText: "[等待用户继续发送]",
      });
      if (this.memoryExtractor && request.text) this.store.enqueueMemoryExtraction(sourceMessageId, request.text);
      return { chunks: [], ...this.affect.expression(this.ownerQQ) };
    }
    const selected = extractStickerDirective(draft);
    const policyResult = selected.text
      ? await this.conversationPolicy.enforce(selected.text, plan, request.text)
      : { text: "……", rewritten: false, violations: [] };
    const finalGrounding = finalCharacterGrounding(policyResult.text, agentRequest, plan, request.text);
    const enforced = {
      text: finalGrounding.text,
      rewritten: policyResult.rewritten || finalGrounding.rewritten,
      violations: [...policyResult.violations, ...finalGrounding.violations],
    };
    const chunks = formatQqReply(enforced.text, request.text);
    chunks.forEach((content, index) => this.store.recordCompanionMessage({
      ownerId: this.ownerQQ,
      clientId: request.clientId,
      externalMessageId: `${sourceMessageId}:assistant:${index}`,
      role: "assistant",
      content,
      occurredAt: Date.now() + index,
    }));
    this.store.recordDialogueAudit({
      sourceMessageId,
      intent: plan.intent,
      move: plan.move,
      questionBudget: plan.questionBudget,
      maxChars: plan.maxChars,
      rewritten: enforced.rewritten,
      violations: enforced.violations,
      finalText: enforced.text,
    });
    if (this.memoryExtractor && request.text) this.store.enqueueMemoryExtraction(sourceMessageId, request.text);
    const expression = this.affect.expression(this.ownerQQ);
    return { chunks, ...expression };
  }

  async synthesizeCompanionVoice(response: CompanionChatResponse): Promise<NonNullable<CompanionChatResponse["voice"]> | null> {
    if (!this.voice || response.chunks.length === 0) return null;
    console.log(`[voice] queued reply chars=${response.chunks.join("\n").length} emotion=${response.emotion}`);
    return this.synthesizeDesktopVoice(response.chunks.join("\n"), response.emotion);
  }

  /** Keep the chat UI in Chinese while the locally trained Emilia model speaks
   * Japanese. Translation is deliberately a separate, literal pass: it must
   * not roleplay, explain, add actions, or invent events. */
  private async synthesizeDesktopVoice(text: string, emotion: CompanionChatResponse["emotion"]): Promise<CompanionChatResponse["voice"]> {
    if (!this.voice) return null;
    let spoken = text;
    const mostlyJapanese = (text.match(/[\u3040-\u30ff]/gu) ?? []).length >= 2;
    if (!mostlyJapanese) {
      if (!this.voiceTranslator) return null;
      try {
        spoken = await this.voiceTranslator.generateReply({
          systemPrompt: "You are a precise Chinese-to-natural-Japanese subtitle translator. Translate only the supplied assistant reply. Preserve its meaning, uncertainty, warmth, and brevity. Do not add facts, names, explanations, roleplay actions, markdown, parentheses, quotes, or labels. Output Japanese only.",
          messages: [{ role: "user", content: text }],
          finalInstruction: "Return one concise spoken Japanese rendering only. No Chinese and no commentary.",
          conversation: { intent: "casual", move: "acknowledge", questionBudget: 0, maxChars: 220 },
        });
        const kana = (spoken.match(/[\u3040-\u30ff]/gu) ?? []).length;
        console.log(`[voice] Japanese rendering received chars=${spoken.length} kana=${kana}`);
      } catch (error) {
        console.warn(`[voice] translation skipped: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }
    try {
      const voice = await this.voice.synthesizeIfJapanese(spoken.replace(/[「」『』“”]/gu, "").trim(), emotion);
      console.log(voice ? `[voice] audio ready bytes=${voice.bytes.length}` : "[voice] skipped: rendering was not Japanese");
      return voice;
    } catch (error) {
      console.warn(`[voice] synthesis skipped: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async runDiscovery(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (!this.discovery || !this.discoveryConfig) {
        await delay(60_000, signal);
        continue;
      }
      try {
        await this.discovery.tick();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[product-core] discovery tick failed: ${detail}`);
      }
      await delay(this.discoveryConfig.pollIntervalMs, signal);
    }
  }

  private async runWeather(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (!this.weather || !this.weatherConfig) {
        await delay(60_000, signal);
        continue;
      }
      try {
        await this.weather.tick();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[product-core] weather tick failed: ${detail}`);
      }
      await delay(this.weatherConfig.pollIntervalMs, signal);
    }
  }

  private async runTaskNotifications(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const notification = this.store.queueNextTaskNotification(this.ownerQQ);
        if (notification) {
          console.log(`[product-core] task notification queued id=${notification.task.id} stage=${notification.stage}`);
          void this.notifyTaskDevices(notification.task.title, notification.stage);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[product-core] task notification failed: ${detail}`);
      }
      await delay(this.core.pollIntervalMs, signal);
    }
  }

  private async notifyTaskDevices(title: string, stage: string): Promise<void> {
    if (!this.devices) return;
    const body = stage === "upcoming" ? `“${title}”快到时间了` : stage === "overdue" ? `“${title}”还没有标记完成` : `“${title}”到时间了`;
    const targets = this.devices.list().filter((device) => device.capabilities.some((capability) => capability.id === "notification.show" && capability.granted));
    await Promise.allSettled(targets.map((device) => this.devices!.execute(device.id, "notification.show", { title: "艾米莉亚的提醒", body }, 8_000)));
  }

  private async runEmailInbox(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (!this.imapInbox) {
        await delay(60_000, signal);
        continue;
      }
      try {
        const stateKey = `imap_cursor:${this.imapInbox.config.user.toLowerCase()}:${this.imapInbox.config.mailbox}`;
        const saved = this.store.getState(stateKey);
        let cursor: ImapCursor | null = null;
        if (saved) {
          try {
            const parsed = JSON.parse(saved) as Record<string, unknown>;
            if (typeof parsed.uidValidity === "string" && Number.isInteger(parsed.lastUid)) {
              cursor = { uidValidity: parsed.uidValidity, lastUid: parsed.lastUid as number };
            }
          } catch {
            this.store.deleteState(stateKey);
            console.warn("[product-core] invalid IMAP cursor discarded");
          }
        }
        const result = await this.imapInbox.reader.poll(cursor);
        for (const message of result.messages) {
          this.store.ingestIncomingEmail({
            account: this.imapInbox.config.user,
            mailbox: this.imapInbox.config.mailbox,
            ...message,
          });
        }
        this.store.setState(stateKey, JSON.stringify(result.cursor));
        if (result.bootstrapped) console.log(`[product-core] IMAP cursor bootstrapped uid=${result.cursor.lastUid}`);
        else if (result.messages.length) console.log(`[product-core] IMAP ingested messages=${result.messages.length}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[product-core] IMAP poll failed: ${detail}`);
      }
      await delay(this.imapInbox.config.pollIntervalMs, signal);
    }
  }

  private async runEmailTriage(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (!this.emailTriage) {
        await delay(60_000, signal);
        continue;
      }
      const email = this.store.claimIncomingEmail();
      if (!email) {
        await delay(this.core.pollIntervalMs, signal);
        continue;
      }
      try {
        const triage = await this.emailTriage.triage(email);
        const notify = email.forceNotify || triage.notify;
        this.store.completeIncomingEmail(email, {
          notify,
          triage,
          notificationBody: notify ? formatImportantEmail(email, triage) : undefined,
          recipientId: notify ? this.ownerQQ : undefined,
        });
        console.log(`[product-core] email triage completed id=${email.id} notify=${notify}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (email.forceNotify) {
          const fallback = { notify: true, urgency: "important" as const, summary: "", reason: "来自重要联系人" };
          this.store.completeIncomingEmail(email, {
            notify: true,
            triage: fallback,
            notificationBody: formatImportantEmail(email, fallback),
            recipientId: this.ownerQQ,
          });
          console.warn(`[product-core] email triage fallback notification id=${email.id}: ${detail}`);
          continue;
        }
        const status = this.store.failIncomingEmail(email, detail);
        console.error(`[product-core] email triage ${status} id=${email.id}: ${detail}`);
      }
    }
  }

  private async runMemoryExtractions(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (!this.memoryExtractor) {
        await delay(this.core.pollIntervalMs, signal);
        continue;
      }
      const job = this.store.claimMemoryExtraction();
      if (!job) {
        await delay(this.core.pollIntervalMs, signal);
        continue;
      }
      try {
        const memories = await this.memoryExtractor.extract(job.text);
        this.store.completeMemoryExtraction(job, memories);
        console.log(`[product-core] memory extraction completed id=${job.id} saved=${memories.length}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const status = this.store.failMemoryExtraction(job, detail);
        console.error(`[product-core] memory extraction ${status} id=${job.id}: ${detail}`);
      }
    }
  }

  private async runActions(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (!this.email && !this.fileService) {
        await delay(this.core.pollIntervalMs, signal);
        continue;
      }
      const action = this.store.claimDueAction();
      if (!action) {
        await delay(this.core.pollIntervalMs, signal);
        continue;
      }
      try {
        if (action.kind === "send_email") {
          if (!this.email) throw new Error("Email service is not configured");
          const to = action.payload.to;
          const subject = action.payload.subject;
          const body = action.payload.body;
          if (typeof to !== "string" || typeof subject !== "string" || typeof body !== "string") throw new Error("Email action payload is invalid");
          const result = await this.email.send({ to, subject, body });
          this.store.markActionCompleted(action.id, result.messageId);
          this.store.enqueue({
            recipientId: this.ownerQQ,
            body: `行动 ${action.id.slice(0, 8)} 已完成：邮件已发送。\n收件人：${to}\n主题：${subject}`,
            dedupeKey: `action-completed:${action.id}`,
          });
        } else if (action.kind === "send_qq_file") {
          if (!this.fileService) throw new Error("Scoped file service is not configured");
          const path = action.payload.path;
          const name = action.payload.name;
          const expectedSize = action.payload.size;
          if (typeof path !== "string" || typeof name !== "string" || typeof expectedSize !== "number") throw new Error("File action payload is invalid");
          const info = await this.fileService.fileInfo(path);
          if (info.type !== "file" || info.size !== expectedSize) throw new Error("File changed after confirmation draft; create a new send action");
          const result = await this.client.sendPrivateFile(this.ownerQQ, info.path, name);
          const externalId = result.file_id === undefined ? null : String(result.file_id);
          this.store.markActionCompleted(action.id, externalId);
          this.store.enqueue({
            recipientId: this.ownerQQ,
            body: `行动 ${action.id.slice(0, 8)} 已完成：文件“${name}”已发送。`,
            dedupeKey: `action-completed:${action.id}`,
          });
        } else if (action.kind === "send_qq_web_image") {
          if (!this.fileService) throw new Error("Scoped file service is not configured");
          const sourceUrl = action.payload.sourceUrl;
          const imageUrl = action.payload.imageUrl;
          const expectedSize = action.payload.expectedSize;
          if (typeof sourceUrl !== "string" || typeof imageUrl !== "string" || typeof expectedSize !== "number") throw new Error("Web image action payload is invalid");
          const image = await this.webImages.resolve(imageUrl);
          if (image.size > Math.max(expectedSize * 2, expectedSize + 1_000_000)) throw new Error("Web image changed substantially after confirmation");
          const path = await this.fileService.cacheDownloadedImage(image.bytes, image.mediaType);
          const result = await this.client.sendPrivateImage(this.ownerQQ, path, { summary: "[图片]" });
          const externalId = "message_id" in result ? String(result.message_id) : null;
          this.store.markActionCompleted(action.id, externalId);
          this.store.enqueue({ recipientId: this.ownerQQ, body: "找到啦，发给你了", dedupeKey: `action-completed:${action.id}` });
        } else {
          throw new Error(`Unsupported action kind: ${action.kind}`);
        }
        console.log(`[product-core] action completed id=${action.id} kind=${action.kind}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const status = this.store.markActionFailed(action, detail);
        console.error(`[product-core] action ${status} id=${action.id}: ${detail}`);
        if (status === "failed") {
          this.store.enqueue({
            recipientId: this.ownerQQ,
            body: `行动 ${action.id.slice(0, 8)} 执行失败，已停止重试。发送 /actions 查看状态。`,
            dedupeKey: `action-failed:${action.id}`,
          });
        }
      }
    }
  }

  private async runOutbox(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const message = this.store.claimDue();
      if (!message) {
        await delay(this.core.pollIntervalMs, signal);
        continue;
      }
      try {
        const stickerId = parseStickerOutboxBody(message.body);
        const sticker = stickerId ? this.store.getSticker(stickerId) : null;
        if (stickerId && !sticker) throw new Error("Sticker no longer exists in the library");
        const result = sticker
          ? await this.client.sendPrivateImage(message.recipientId, sticker.path.startsWith("file:") ? sticker.path : pathToFileURL(sticker.path).href, sticker.nativePayload ?? {})
          : await this.client.sendPrivateMessage(message.recipientId, message.body);
        const externalId = result.message_id === undefined ? null : String(result.message_id);
        this.store.markSent(message.id, externalId);
        if (sticker) this.store.markStickerUsed(sticker.id);
        if (!sticker && message.recipientId === this.ownerQQ) {
          this.companionBridge?.broadcast({ type: "assistant.reply", source: "qq", text: message.body, ...this.affect.expression(this.ownerQQ) });
        }
        console.log(`[product-core] outbox sent id=${message.id}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const status = this.store.markFailed(message, detail);
        console.error(`[product-core] outbox ${status} id=${message.id}: ${detail}`);
      }
    }
  }

  private async runInbound(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.listenUntilClosed(signal);
      } catch (error) {
        if (!signal.aborted) {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`[product-core] websocket disconnected: ${detail}`);
        }
      }
      if (!signal.aborted) await delay(this.core.reconnectDelayMs, signal);
    }
  }

  private listenUntilClosed(signal: AbortSignal): Promise<void> {
    const endpoint = new URL(this.oneBot.wsUrl);
    endpoint.searchParams.set("access_token", this.oneBot.accessToken);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
        if (error) reject(error);
        else resolve();
      };
      const abort = (): void => finish();
      signal.addEventListener("abort", abort, { once: true });
      socket.addEventListener("open", () => console.log("[product-core] websocket connected"));
      socket.addEventListener("error", () => finish(new Error("OneBot WebSocket error")));
      socket.addEventListener("close", () => finish());
      socket.addEventListener("message", (messageEvent) => {
        try {
          const event = privateMessage(JSON.parse(String(messageEvent.data)));
          if (!event) return;
          const senderId = String(event.user_id);
          if (!this.oneBot.allowedQQs.has(senderId)) {
            console.warn("[product-core] ignored private message from non-allowlisted account");
            return;
          }
          this.inboundChain = this.inboundChain
            .then(() => this.processInbound(event, senderId))
            .catch((error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error);
              console.error(`[product-core] inbound processing failed: ${detail}`);
            });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`[product-core] inbound event rejected: ${detail}`);
        }
      });
    });
  }

  private async processInbound(event: PrivateMessageEvent, senderId: string): Promise<void> {
    const parsed = parseOneBotMessage(event.message, event.raw_message ?? "");
    const text = parsed.text;
    const externalMessageId = String(event.message_id ?? randomUUID());
    const standaloneSticker = parsed.image ? isLikelyQqSticker(parsed.image, text) : false;
    const silentFace = !text && parsed.faces.length > 0 && !parsed.image;
    const silentEmoji = !parsed.image && parsed.faces.length === 0 && isOnlyEmojiMessage(text);
    const silentNonverbal = standaloneSticker || silentFace || silentEmoji;
    const storedBody = parsed.image ? `[图片]${text ? ` ${text}` : ""}`
      : silentFace ? "[QQ表情]" : text;
    const inserted = this.store.recordInbound({
      channel: "qq_onebot",
      externalMessageId,
      senderId,
      body: storedBody,
      receivedAt: (event.time ?? Math.floor(Date.now() / 1000)) * 1000,
      conversationVisible: !silentNonverbal,
    });
    if (!inserted) return;
    if (!silentNonverbal) this.affect.observeUserMessage(this.ownerQQ, externalMessageId, text || storedBody);
    console.log("[product-core] inbound private message persisted");

    const targetOutboxId = this.store.latestAssistantOutboxId(this.ownerQQ);
    for (const feedback of detectStyleFeedback(text)) {
      this.store.recordStyleFeedback({ ...feedback, sourceMessageId: externalMessageId, targetOutboxId });
      console.log(`[product-core] style feedback recorded category=${feedback.category} sentiment=${feedback.sentiment}`);
    }

    if (parsed.image) {
      await this.processImage(parsed.image, text, externalMessageId, standaloneSticker);
      return;
    }

    if (silentFace || silentEmoji) {
      console.log("[product-core] standalone nonverbal message recorded without reply");
      return;
    }

    const hasPendingSticker = this.store.getState("pending_sticker_candidate") !== null;
    const contextualSave = hasPendingSticker && /(?:保存|记住|收下|存下|学会)(?:一下|试试)?|(?:这个|它|也).{0,6}(?:可以)?表示/u.test(text);
    if (isStickerTeachingCaption(text) || contextualSave) {
      const saved = await this.learnPendingSticker(text);
      if (!saved) this.store.setState("pending_sticker_instruction", JSON.stringify({ caption: text, createdAt: Date.now() }));
      this.store.enqueue({
        recipientId: this.ownerQQ,
        body: saved ? naturalVariant(STICKER_SAVED_REPLIES) : naturalVariant(["好，发过来吧。", "嗯，把那张给我。"]),
      });
      return;
    }

    const recentlyLearnedAt = Number(this.store.getState("last_sticker_learned_at") ?? 0);
    const recentStickerWindow = Date.now() - recentlyLearnedAt < 5 * 60_000;
    if (recentStickerWindow && /^(?:这个|它|也).{0,6}(?:可以)?表示/u.test(text)) {
      this.store.enrichLatestSticker(text);
      this.store.enqueue({ recipientId: this.ownerQQ, body: "嗯，这个用法也记上了。" });
      return;
    }
    const refersToRecentSticker = recentStickerWindow
      && /(?:(?:现在|那就|试试|把它)?.{0,8}(?:发出来|发给我|来一个|发送一下|发一下)|假设.{0,12}(?:发送|发))/u.test(text);
    if (isStickerSendRequest(text) || refersToRecentSticker) {
      const sticker = this.store.findSticker(text);
      if (!sticker) {
        this.store.enqueue({ recipientId: this.ownerQQ, body: "表情库现在还是空的，我不能假装已经发了。先教我保存一张吧。" });
      } else {
        this.store.enqueue({ recipientId: this.ownerQQ, body: stickerOutboxBody(sticker.id) });
      }
      return;
    }

    const emailCommand = handleEmailInstruction(
      text,
      this.store,
      `qq-email:${String(event.message_id ?? "unknown")}`,
      this.email !== null,
    );
    if (emailCommand.handled) {
      if (emailCommand.reply) this.store.enqueue({ recipientId: this.ownerQQ, body: emailCommand.reply });
      return;
    }

    if (this.devices) {
      const deviceCommand = await handleDeviceCommand(text, this.devices);
      if (deviceCommand.handled) {
        if (deviceCommand.reply) this.store.enqueue({ recipientId: this.ownerQQ, body: deviceCommand.reply });
        return;
      }
    }

    const command = handleCoreCommand(text, this.store, this.ownerQQ, Date.now(), `qq-task:${String(event.message_id ?? "unknown")}`);
    if (command.handled) {
      if (command.reply) this.store.enqueue({ recipientId: this.ownerQQ, body: command.reply });
      return;
    }
    if (!this.agent) {
      console.log("[product-core] agent is not configured; message stored without automatic reply");
      return;
    }

    this.replyScheduler!.notify(replyQuietWindowMs(text));
    console.log("[product-core] agent reply scheduled");
  }

  private async processImage(image: OneBotImageReference, caption: string, externalMessageId: string, silentReply = false): Promise<void> {
    if (!this.vision) {
      if (!silentReply) this.store.enqueue({ recipientId: this.ownerQQ, body: "我收到了图片，但视觉模型还没有配置好。" });
      return;
    }
    let stage = "acquire-image";
    try {
      let path = "";
      let bytes: Buffer | null = null;
      let mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null = null;
      if (image.url && this.fileService) {
        try {
          stage = "download-qq-cdn";
          const downloaded = await this.webImages.resolve(image.url);
          bytes = downloaded.bytes;
          mediaType = downloaded.mediaType;
          path = await this.fileService.cacheDownloadedImage(downloaded.bytes, downloaded.mediaType);
          console.log(`[product-core] inbound image acquired from QQ CDN size=${downloaded.size}`);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(`[product-core] QQ CDN image acquisition failed; falling back to NapCat: ${detail}`);
        }
      }
      if (!bytes || !mediaType || !path) {
        stage = "napcat-get-image";
        const imageInfo = await this.client.getImage(image.file);
        if (imageInfo.bytes) {
          stage = "read-worker-image";
          bytes = imageInfo.bytes;
          if (bytes.length > 50 * 1024 * 1024) throw new Error("Image exceeds the 50MB worker transfer limit");
          mediaType = detectImageMediaType(bytes);
          if (!mediaType) throw new Error("Unsupported or invalid image format");
          if (this.fileService) path = await this.fileService.cacheDownloadedImage(bytes, mediaType);
        } else {
          if (!imageInfo.file) throw new Error("NapCat did not return a local image path");
          path = imageInfo.file.startsWith("file:") ? fileURLToPath(imageInfo.file) : imageInfo.file;
          stage = "read-local-image";
          const metadata = await stat(path);
          if (!metadata.isFile()) throw new Error("NapCat image path is not a file");
          if (metadata.size > 50 * 1024 * 1024) throw new Error("Image exceeds the 50MB local processing limit");
          bytes = await readFile(path);
          mediaType = detectImageMediaType(bytes);
          if (!mediaType) throw new Error("Unsupported or invalid image format");
        }
      }
      stage = "prepare-vision-image";
      const visionImage = await prepareVisionImage({ bytes, mediaType }, this.visionMaxImageBytes);
      const suffix = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" }[mediaType];
      let analysis = "视觉分析暂未完成，主要依据用户给出的含义使用。";
      try {
        stage = "vision-model";
        analysis = await this.vision.analyze(visionImage, [
          "你是艾米莉亚的视觉感知模块。请准确分析用户发来的图片，并用中文提供事实性观察。",
          "识别主要对象、场景、界面或文档结构；如有文字请提取关键文字；不确定之处要明确说明。",
          caption ? `用户附言：${caption}` : "用户没有附言，请判断图片内容并给出自然回应所需的信息。",
        ].join("\n"));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[product-core] image analysis unavailable; preserving image candidate: ${detail}`);
      }
      stage = "persist-image-analysis";
      this.store.recordImageAnalysis(
        "qq_onebot",
        externalMessageId,
        `[用户发送了一张图片。视觉模型分析如下：\n${analysis}\n用户附言：${caption || "无"}]`,
      );
      const pendingInstruction = this.pendingStickerInstruction();
      const teachingCaption = isStickerTeachingCaption(caption) ? caption : pendingInstruction?.caption ?? "";
      if (teachingCaption) {
        const sticker = await this.stickers.learn(path, teachingCaption, analysis, suffix, { summary: image.summary, subType: image.subType });
        this.store.deleteState("pending_sticker_candidate");
        this.store.deleteState("pending_sticker_instruction");
        this.store.setState("last_sticker_learned_at", String(Date.now()));
        this.store.enqueue({ recipientId: this.ownerQQ, body: naturalVariant(STICKER_SAVED_REPLIES) });
        console.log(`[product-core] sticker learned id=${sticker.id}`);
        return;
      }
      this.store.setState("pending_sticker_candidate", JSON.stringify({
        path,
        analysis,
        suffix,
        nativePayload: { summary: image.summary, subType: image.subType },
        createdAt: Date.now(),
      }));
      if (silentReply) {
        console.log("[product-core] standalone sticker analyzed and cached without reply");
        return;
      }
      if (!this.agent) {
        this.store.enqueue({ recipientId: this.ownerQQ, body: analysis.slice(0, 4000) });
        return;
      }
      this.replyScheduler!.notify(replyQuietWindowMs(caption));
      console.log("[product-core] image analyzed and agent reply scheduled");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[product-core] image processing failed stage=${stage}: ${detail}`);
      if (!silentReply) this.store.enqueue({ recipientId: this.ownerQQ, body: "这张图刚才没取到……你再发一次试试" });
    }
  }

  private async learnPendingSticker(caption: string): Promise<boolean> {
    const raw = this.store.getState("pending_sticker_candidate");
    if (!raw) return false;
    try {
      const candidate = JSON.parse(raw) as { path?: unknown; analysis?: unknown; suffix?: unknown; nativePayload?: unknown; createdAt?: unknown };
      if (typeof candidate.path !== "string" || typeof candidate.analysis !== "string" || typeof candidate.suffix !== "string"
        || typeof candidate.createdAt !== "number" || Date.now() - candidate.createdAt > STICKER_TEACHING_WINDOW_MS) {
        this.store.deleteState("pending_sticker_candidate");
        return false;
      }
      const metadata = await stat(candidate.path);
      if (!metadata.isFile()) return false;
      const nativePayload = candidate.nativePayload && typeof candidate.nativePayload === "object"
        ? candidate.nativePayload as { summary?: string; subType?: number }
        : null;
      await this.stickers.learn(candidate.path, caption, candidate.analysis, candidate.suffix, nativePayload);
      this.store.deleteState("pending_sticker_candidate");
      this.store.deleteState("pending_sticker_instruction");
      this.store.setState("last_sticker_learned_at", String(Date.now()));
      console.log("[product-core] pending sticker learned from follow-up caption");
      return true;
    } catch {
      this.store.deleteState("pending_sticker_candidate");
      return false;
    }
  }

  private pendingStickerInstruction(): { caption: string; createdAt: number } | null {
    const raw = this.store.getState("pending_sticker_instruction");
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as { caption?: unknown; createdAt?: unknown };
      if (typeof value.caption === "string" && typeof value.createdAt === "number" && Date.now() - value.createdAt <= STICKER_TEACHING_WINDOW_MS) {
        return { caption: value.caption, createdAt: value.createdAt };
      }
    } catch {
      // Invalid transient state is cleared below.
    }
    this.store.deleteState("pending_sticker_instruction");
    return null;
  }
}

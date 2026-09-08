import {
  OpenAICompatibleAgent,
  type AgentAdapter,
  type AgentConfig,
  type AgentRequest,
} from "./agent.ts";
import { emiliaAnchorContext } from "./emilia-anchors.ts";
import { EMILIA_CHARACTER_PROMPT, EMILIA_SYSTEM_PROMPT } from "./persona.ts";
import { heuristicConversationPlan, type ConversationIntent, type ConversationPlan } from "./conversation-policy.ts";
import {
  characterEmotionIntensity,
  fallbackTurnFrame,
  groundingFallback,
  hybridCharacterInstruction,
  validateStructuredGrounding,
} from "./structured-character.ts";
import {
  REFERENCE_DIALOGUE_EXAMPLES,
  REFERENCE_NO_REPLY,
  ReferenceEpisodePlanner,
  referencePostHistoryInstruction,
  sanitizeReferenceReply,
} from "./reference-character.ts";

export interface RoleplayConfig extends AgentConfig {
  enabled: true;
}

function enabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected a number between ${min} and ${max}, received ${value}`);
  }
  return parsed;
}

export function loadRoleplayConfig(env: NodeJS.ProcessEnv = process.env): RoleplayConfig | null {
  if (!enabled(env.ROLEPLAY_ENABLED)) return null;
  const apiKey = env.ROLEPLAY_API_KEY?.trim();
  if (!apiKey) throw new Error("ROLEPLAY_API_KEY is required when ROLEPLAY_ENABLED=true");
  const baseUrl = env.ROLEPLAY_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("ROLEPLAY_BASE_URL must use HTTPS unless it points to localhost");
  }
  return {
    enabled: true,
    mode: "direct",
    baseUrl: url.toString().replace(/\/$/u, ""),
    apiKey,
    model: env.ROLEPLAY_MODEL?.trim() || "qwen-flash-character-2026-02-26",
    maxTokens: Math.trunc(boundedNumber(env.ROLEPLAY_MAX_TOKENS, 500, 64, 4096)),
    temperature: boundedNumber(env.ROLEPLAY_TEMPERATURE, 0.85, 0, 2),
    timeoutMs: Math.trunc(boundedNumber(env.ROLEPLAY_TIMEOUT_MS, 60_000, 1000, 300_000)),
    contextMessages: Math.trunc(boundedNumber(env.ROLEPLAY_CONTEXT_MESSAGES, 20, 2, 100)),
  };
}

export const ROLEPLAY_CHAT_CONTRACT = [
  "这是现实中的 QQ 即时聊天，不是小说、舞台剧或视觉小说。",
  "不要用括号描写动作、神态、心理或场景，不写旁白，不使用星号动作。",
  "少女感来自当下反应、措辞和判断，不来自撒娇模板、波浪号或夸张语气词。",
  "只把对话记录里由用户说出的经历归给用户，不能改写成自己经历过、看见过或刚做过的事。",
  "长期记忆只是可能相关的过去背景，不能据此猜测用户此刻刚刚在做什么；没有本轮证据就不要补全。",
  "不要虚构自己刚在现实中整理桌面、照顾植物、玩游戏或完成其他动作；只有工具结果明确记录的动作才可以当成已经发生。",
  "不要习惯性用‘真的吗’开头，也不要用‘辛苦啦、注意身体’这类泛用慰问代替具体反应。",
  "遵循本轮对话动作；一句说完就停，不主动解释人设。",
].join("\n");

export function roleplayIntent(request: AgentRequest): ConversationIntent | null {
  if (request.conversation?.intent) return request.conversation.intent;
  const instruction = request.finalInstruction ?? "";
  return (/(?:^|[;\s])intent=(casual|vent|emotional|question|task|detailed)(?:[;\s]|$)/u.exec(instruction)?.[1]
    ?? /本轮意图[：:]\s*(casual|vent|emotional|question|task|detailed)/u.exec(instruction)?.[1]
    ?? null) as ConversationIntent | null;
}

export function roleplayEligible(request: AgentRequest): boolean {
  const intent = roleplayIntent(request);
  return intent === "casual" || intent === "vent" || intent === "emotional";
}

function conversationPlan(request: AgentRequest, latestUserText: string): ConversationPlan {
  const fallback = heuristicConversationPlan(latestUserText);
  if (!request.conversation) return { ...fallback, intent: roleplayIntent(request) ?? fallback.intent };
  return { ...request.conversation, needsClarification: false, reason: "production conversation policy" };
}

export class RoleplayRoutingAgent implements AgentAdapter {
  private readonly primary: AgentAdapter;
  private readonly roleplay: AgentAdapter;
  private readonly episodePlanner: ReferenceEpisodePlanner;

  constructor(primary: AgentAdapter, roleplay: AgentAdapter, episodePlanner = new ReferenceEpisodePlanner(null)) {
    this.primary = primary;
    this.roleplay = roleplay;
    this.episodePlanner = episodePlanner;
  }

  async generateReply(request: AgentRequest): Promise<string> {
    const latestUserText = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const plan = conversationPlan(request, latestUserText);
    const episode = await this.episodePlanner.plan(request.messages, plan);
    if (episode.frame.waitForContinuation) {
      console.log("[product-core] character episode is unfinished; waiting for the user's continuation");
      return REFERENCE_NO_REPLY;
    }
    const episodeInstruction = [
      REFERENCE_DIALOGUE_EXAMPLES,
      referencePostHistoryInstruction(episode.frame),
    ].join("\n\n");
    const episodeAwareRequest: AgentRequest = {
      ...request,
      finalInstruction: [request.finalInstruction, episodeInstruction].filter(Boolean).join("\n\n"),
    };
    const frame = fallbackTurnFrame(request.messages, plan, request.grounding?.verifiedMemories ?? []);
    const hardGuard = frame.hardConstraint.kind !== "none";
    if (!roleplayEligible(request) && !hardGuard) return this.primary.generateReply(episodeAwareRequest);
    try {
      const dynamicContext = episodeAwareRequest.systemPrompt.startsWith(EMILIA_SYSTEM_PROMPT)
        ? episodeAwareRequest.systemPrompt.slice(EMILIA_SYSTEM_PROMPT.length).trim()
        : episodeAwareRequest.systemPrompt;
      const intensity = characterEmotionIntensity(frame, latestUserText);
      const guarded = hardGuard || plan.intent === "vent" || plan.intent === "emotional";
      const basePrompt = [
        EMILIA_CHARACTER_PROMPT,
        dynamicContext,
        emiliaAnchorContext(latestUserText),
        episodeAwareRequest.finalInstruction,
        ROLEPLAY_CHAT_CONTRACT,
        guarded ? hybridCharacterInstruction(frame, intensity) : "",
      ].filter(Boolean).join("\n\n");
      const roleplayRequest: AgentRequest = {
        ...episodeAwareRequest,
        // Qwen Character expects one leading system message. A second system
        // message after the transcript can be echoed as if it were dialogue.
        systemPrompt: basePrompt,
        finalInstruction: undefined,
      };
      const draft = sanitizeReferenceReply(await this.roleplay.generateReply(roleplayRequest));
      const violations = validateStructuredGrounding(draft, frame, latestUserText);
      if (violations.length === 0) {
        console.log(`[product-core] character route=${guarded ? "guarded" : "legacy"} intent=${plan.intent} hard=${frame.hardConstraint.kind} intensity=${intensity} repaired=false`);
        return draft;
      }
      const repaired = sanitizeReferenceReply(await this.roleplay.generateReply({
        ...roleplayRequest,
        systemPrompt: [
          basePrompt,
          "【草稿纠错】",
          `原草稿：${JSON.stringify(draft.slice(0, 1200))}`,
          `发现的问题：${violations.join("；")}。只修正这些问题，不增加情绪强度，不添加新事实，直接输出修改后的聊天文本。`,
        ].join("\n\n"),
      }));
      const remaining = validateStructuredGrounding(repaired, frame, latestUserText);
      console.log(`[product-core] character route=${guarded ? "guarded" : "legacy"} intent=${plan.intent} hard=${frame.hardConstraint.kind} intensity=${intensity} repaired=true fallback=${remaining.length > 0}`);
      return remaining.length === 0 ? repaired : groundingFallback(repaired, frame, remaining);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[product-core] roleplay model failed; falling back to primary agent: ${detail}`);
      return this.primary.generateReply(episodeAwareRequest);
    }
  }
}

export function createRoleplayAgent(config: RoleplayConfig | null): AgentAdapter | null {
  return config ? new OpenAICompatibleAgent(config) : null;
}

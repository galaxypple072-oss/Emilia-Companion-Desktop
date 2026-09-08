import type { AgentAdapter, AgentMessage } from "./agent.ts";
import type { ConversationPlan } from "./conversation-policy.ts";

export type DialogueAct = "acknowledge" | "react" | "comfort" | "celebrate" | "opine" | "correct" | "set_boundary" | "answer" | "act" | "stay_quiet";
export type EmotionalStance = "light" | "warm" | "concerned" | "firm" | "apologetic" | "neutral";
export type HardConstraintKind = "none" | "unverified_shared_memory" | "core_value_conflict" | "user_correction" | "unobservable_reality";

export interface HardConstraint {
  kind: HardConstraintKind;
  reason: string;
  requiredBehavior: string;
  forbiddenBehavior: string[];
}

export interface CharacterTurnFrame {
  speechAct: "sharing" | "venting" | "emotion" | "question" | "correction" | "boundary" | "task" | "backchannel" | "memory_claim" | "value_conflict";
  dialogueAct: DialogueAct;
  emotionalStance: EmotionalStance;
  activatedTraits: string[];
  questionBudget: 0 | 1;
  maxChars: number;
  maxBubbles: number;
  evidence: string[];
  forbiddenAssumptions: string[];
  hardConstraint: HardConstraint;
}

export interface StructuredReply {
  content: string;
  bubbles: string[];
  parsed: boolean;
}

const SPEECH_ACTS = new Set<CharacterTurnFrame["speechAct"]>(["sharing", "venting", "emotion", "question", "correction", "boundary", "task", "backchannel", "memory_claim", "value_conflict"]);
const DIALOGUE_ACTS = new Set<DialogueAct>(["acknowledge", "react", "comfort", "celebrate", "opine", "correct", "set_boundary", "answer", "act", "stay_quiet"]);
const STANCES = new Set<EmotionalStance>(["light", "warm", "concerned", "firm", "apologetic", "neutral"]);

function jsonObject(output: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/iu.exec(output)?.[1];
  if (fenced) return JSON.parse(fenced) as Record<string, unknown>;
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("缺少 JSON 对象");
  return JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
}

function trailingUserEvidence(messages: AgentMessage[]): string[] {
  const evidence: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && evidence.length > 0) break;
    if (message.role === "user") evidence.unshift(message.content.replace(/\s+/gu, " ").trim().slice(0, 500));
  }
  return evidence.filter(Boolean).slice(-6);
}

function latestUser(messages: AgentMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content.replace(/\s+/gu, " ").trim() ?? "";
}

export function detectHardConstraint(messages: AgentMessage[], verifiedSharedMemories: string[] = []): HardConstraint {
  const latest = latestUser(messages);
  const asksAboutUnseenEnvironment = /(?:桌上|桌面|屏幕|房间|摄像头|你能看见|你看得到)/u.test(latest)
    && /(?:什么|是不是|有没有|整理|看到|看见|看得到|放着)/u.test(latest);
  if (asksAboutUnseenEnvironment) return {
    kind: "unobservable_reality",
    reason: "用户询问了当前线上对话无法直接感知的现实环境",
    requiredBehavior: "用自然的聊天口吻说明现在看不到；可以请用户发图，但不能猜测具体内容",
    forbiddenBehavior: ["声称看见桌面、屏幕或房间", "猜测具体物品", "声称做过现实整理动作"],
  };
  const correction = /(?:不是|不对|我说的是|你没听懂|你记错了|说错了)/u.test(latest);
  if (correction) return {
    kind: "user_correction",
    reason: "用户明确纠正了先前事实",
    requiredBehavior: "直接接受纠正并使用新事实，不辩解，不扩写未知关系",
    forbiddenBehavior: ["继续使用被纠正的旧事实", "猜测更多关系细节", "连续道歉"],
  };
  const sharedMemoryClaim = /(?:你还记得|还记得吗|你记不记得|记得不).{0,80}(?:我们|咱们|一起)|(?:我们|咱们).{0,60}(?:一起|去年|上次|之前).{0,40}(?:吗|吧|呢)?/u.test(latest);
  if (sharedMemoryClaim) {
    const normalized = latest.replace(/\s+/gu, "");
    const verified = verifiedSharedMemories.some((memory) => {
      const terms = memory.replace(/\s+/gu, "").split(/[，。！？、,.!?\s]/u).filter((term) => term.length >= 2);
      return terms.length >= 2 && terms.filter((term) => normalized.includes(term)).length >= 2;
    });
    if (!verified) return {
      kind: "unverified_shared_memory",
      reason: "用户暗示了一段共同经历，但系统没有对应的已验证记忆",
      requiredBehavior: "温和说明自己没有这段可靠记忆，不能假装记得",
      forbiddenBehavior: ["承认记得", "补写时间地点细节", "虚构共同经历"],
    };
  }
  const prejudice = /(?:那种|这种|某种|那些|这些).{0,16}(?:出身|血统|种族|民族|地域|家庭|阶层|性别).{0,30}(?:不值得|不能|都不|就是|天生)|(?:出身|血统|种族|民族|地域|家庭|阶层|性别).{0,30}(?:不值得信任|低人一等|都一样|决定一切)/u.test(latest);
  if (prejudice) return {
    kind: "core_value_conflict",
    reason: "用户观点与艾米莉亚关于公平和个体尊严的核心价值冲突",
    requiredBehavior: "明确但不辱骂地反对按出身否定个人，表达自己的真实立场",
    forbiddenBehavior: ["附和偏见", "把偏见原句当作自己的观点复述", "只做中立倾听", "用表情逃避立场"],
  };
  return { kind: "none", reason: "没有触发硬边界", requiredBehavior: "遵循柔性对话规划", forbiddenBehavior: [] };
}

export function fallbackTurnFrame(messages: AgentMessage[], plan: ConversationPlan, verifiedSharedMemories: string[] = []): CharacterTurnFrame {
  const latest = latestUser(messages);
  const hardConstraint = detectHardConstraint(messages, verifiedSharedMemories);
  const correction = /(?:不是|不对|我说的是|你没听懂|说错了)/u.test(latest);
  const boundary = /(?:别|不要|停止|先别|不用).{0,12}(?:问|说|角色|语气|追问|继续)/u.test(latest);
  const backchannel = /^(?:嗯+|哦+|好(?:吧|的)?|行|知道了|哈哈+|呵呵+|……|[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+)$/u.test(latest);
  const speechAct: CharacterTurnFrame["speechAct"] = hardConstraint.kind === "unverified_shared_memory" ? "memory_claim"
    : hardConstraint.kind === "core_value_conflict" ? "value_conflict" : correction ? "correction" : boundary ? "boundary" : backchannel ? "backchannel"
    : plan.intent === "vent" ? "venting" : plan.intent === "emotional" ? "emotion" : plan.intent === "question" || plan.intent === "detailed" ? "question"
      : plan.intent === "task" ? "task" : "sharing";
  const dialogueAct: DialogueAct = hardConstraint.kind === "unverified_shared_memory" ? "correct"
    : hardConstraint.kind === "core_value_conflict" ? "set_boundary" : correction ? "correct" : boundary ? "set_boundary" : backchannel ? "acknowledge"
    : plan.intent === "vent" ? "react" : plan.intent === "emotional" ? "comfort" : plan.intent === "question" || plan.intent === "detailed" ? "answer"
      : plan.intent === "task" ? "act" : "react";
  const emotionalStance: EmotionalStance = hardConstraint.kind === "core_value_conflict" ? "firm"
    : hardConstraint.kind === "unverified_shared_memory" || hardConstraint.kind === "unobservable_reality" ? "warm" : correction ? "apologetic" : boundary ? "neutral" : plan.intent === "vent" ? "warm"
    : plan.intent === "emotional" ? "concerned" : "light";
  return {
    speechAct,
    dialogueAct,
    emotionalStance,
    activatedTraits: hardConstraint.kind === "core_value_conflict" ? ["公平", "坚定", "尊重个体"]
      : hardConstraint.kind === "unverified_shared_memory" || hardConstraint.kind === "unobservable_reality" ? ["诚实", "自然"]
        : plan.intent === "emotional" ? ["温柔", "认真"] : ["自然", "有自己的反应"],
    questionBudget: plan.questionBudget,
    maxChars: plan.maxChars,
    maxBubbles: plan.intent === "detailed" ? 10 : plan.intent === "emotional" ? 3 : 2,
    evidence: trailingUserEvidence(messages),
    forbiddenAssumptions: ["用户未明说的事件原因", "不存在的图片、现实动作或共同经历", "没有工具结果支持的完成状态"],
    hardConstraint,
  };
}

export function characterEmotionIntensity(frame: CharacterTurnFrame, userText: string): 0 | 1 | 2 {
  if (frame.hardConstraint.kind === "core_value_conflict") return 2;
  if (frame.hardConstraint.kind === "unverified_shared_memory" || frame.hardConstraint.kind === "user_correction" || frame.hardConstraint.kind === "unobservable_reality") return 1;
  if (frame.speechAct === "emotion") return /(?:崩溃|绝望|害怕|想哭|受不了|特别难受)/u.test(userText) ? 2 : 1;
  if (frame.speechAct === "venting") return 1;
  return 0;
}

export function hybridCharacterInstruction(frame: CharacterTurnFrame, intensity: 0 | 1 | 2): string {
  const intensityRule = intensity === 0
    ? "保持轻松或中性，不放大情绪。"
    : intensity === 1
      ? "可以共情或轻微抱怨，但不要给用户或第三方贴标签，不要替用户断定长期习惯和原因。"
      : "可以明确认真，但不辱骂、不指控、不把推测写成结论。";
  return [
    "【本轮事实与角色边界】",
    `对话动作：${frame.dialogueAct}；情绪强度：${intensity}/2；最多 ${frame.maxChars} 字；最多提问 ${frame.questionBudget} 次。`,
    `用户本轮直接说过：${frame.evidence.map((item) => JSON.stringify(item)).join("；") || "（无）"}`,
    frame.hardConstraint.kind === "none" ? "没有额外硬边界。" : `必须做到：${frame.hardConstraint.requiredBehavior}。禁止：${frame.hardConstraint.forbiddenBehavior.join("；")}。`,
    "这些只是事实和边界，不是表演风格。沿用原本自然、柔软、有点生涩的聊天语感，不要因为这段规则变得强势、说教或像客服。",
    intensityRule,
    "不得把猜测写成事实；不得虚构共同经历、现实动作、查阅结果或用户没说过的细节。除非本轮明确需要，情绪不要高于上述强度。",
  ].join("\n");
}

export function parseTurnFrame(output: string, fallback: CharacterTurnFrame): CharacterTurnFrame {
  const value = jsonObject(output);
  const traits = Array.isArray(value.activated_traits)
    ? value.activated_traits.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 3)
    : fallback.activatedTraits;
  const parsed = {
    ...fallback,
    speechAct: SPEECH_ACTS.has(value.speech_act as CharacterTurnFrame["speechAct"]) ? value.speech_act as CharacterTurnFrame["speechAct"] : fallback.speechAct,
    dialogueAct: DIALOGUE_ACTS.has(value.dialogue_act as DialogueAct) ? value.dialogue_act as DialogueAct : fallback.dialogueAct,
    emotionalStance: STANCES.has(value.emotional_stance as EmotionalStance) ? value.emotional_stance as EmotionalStance : fallback.emotionalStance,
    activatedTraits: traits.length ? traits : fallback.activatedTraits,
    // The planner cannot expand question or length budgets. These remain
    // deterministic policy decisions rather than model suggestions.
    questionBudget: fallback.questionBudget,
    maxChars: fallback.maxChars,
    maxBubbles: fallback.maxBubbles,
    evidence: fallback.evidence,
    forbiddenAssumptions: fallback.forbiddenAssumptions,
    hardConstraint: fallback.hardConstraint,
  };
  if (fallback.hardConstraint.kind !== "none") {
    parsed.speechAct = fallback.speechAct;
    parsed.dialogueAct = fallback.dialogueAct;
    parsed.emotionalStance = fallback.emotionalStance;
    parsed.activatedTraits = fallback.activatedTraits;
  }
  return parsed;
}

export class StructuredTurnPlanner {
  private readonly agent: AgentAdapter | null;

  constructor(agent: AgentAdapter | null) {
    this.agent = agent;
  }

  async plan(messages: AgentMessage[], conversationPlan: ConversationPlan): Promise<{ frame: CharacterTurnFrame; usedModel: boolean }> {
    const fallback = fallbackTurnFrame(messages, conversationPlan);
    if (!this.agent) return { frame: fallback, usedModel: false };
    try {
      const output = await this.agent.generateReply({
        systemPrompt: [
          "你是即时聊天的回合规划器，不写最终回复，也不进行角色表演。",
          "只判断对话行为和情绪立场，不补充用户没说过的事实，不输出推理过程。",
          "speech_act 只能是 sharing, venting, emotion, question, correction, boundary, task, backchannel, memory_claim, value_conflict。",
          "dialogue_act 只能是 acknowledge, react, comfort, celebrate, opine, correct, set_boundary, answer, act, stay_quiet。",
          "emotional_stance 只能是 light, warm, concerned, firm, apologetic, neutral。",
          "activated_traits 最多三个简短中文词。",
          "只输出 JSON：speech_act, dialogue_act, emotional_stance, activated_traits。",
        ].join("\n"),
        messages: [{ role: "user", content: JSON.stringify({ transcript: messages.slice(-8), fixed_policy: { question_budget: fallback.questionBudget, max_chars: fallback.maxChars, max_bubbles: fallback.maxBubbles } }) }],
      });
      return { frame: parseTurnFrame(output, fallback), usedModel: true };
    } catch {
      return { frame: fallback, usedModel: false };
    }
  }
}

export function structuredFrameInstruction(frame: CharacterTurnFrame): string {
  return [
    "【本轮结构化决策】",
    JSON.stringify({
      speech_act: frame.speechAct,
      dialogue_act: frame.dialogueAct,
      emotional_stance: frame.emotionalStance,
      activated_traits: frame.activatedTraits,
      question_budget: frame.questionBudget,
      max_chars: frame.maxChars,
      max_bubbles: frame.maxBubbles,
      direct_user_evidence: frame.evidence,
      forbidden_assumptions: frame.forbiddenAssumptions,
      hard_constraint: frame.hardConstraint,
    }),
    "hard_constraint 是不可覆盖的角色与事实边界；只围绕一个 dialogue_act 回复。direct_user_evidence 只是用户说过的话，不自动等于真实历史。",
    "直接输出最终聊天文本。一个气泡一行，最多使用 max_bubbles 行；不要输出JSON、字段名、动作、旁白、解释或Markdown。",
  ].join("\n");
}

export function validateStructuredGrounding(reply: string, frame: CharacterTurnFrame, userText: string): string[] {
  const text = reply.replace(/\s+/gu, " ").trim();
  const violations: string[] = [];
  if (/[{}]|["']?bubbles["']?\s*:/iu.test(text)) violations.push("structured protocol leaked into chat");
  if (/(?:我现在|我刚刚|我刚才|我今天|我昨天|我上次|我之前).{0,45}(?:看到|看见|听到|正在|去了?|在(?:图书馆|学校|公司|家里|路上)|整理|打开|买了?|吃了?|喝了?|遇到)|我(?:也)?有过.{0,28}(?:经历|时候)|我(?:之前|曾经).{0,35}(?:去过|看过|遇到过|做过)/u.test(text)) {
    violations.push("invented an unsupported first-person real-world experience");
  }
  if (/(?:我|刚刚|已经)(?:查了|查过|查了一下|看了|翻了|检查了|读取了).{0,35}(?:记录|照片|文件|邮件|行程|数据库|日历)|(?:记录|文件|邮件|行程|日历).{0,20}(?:显示|写着|证明)/u.test(text)) {
    violations.push("claimed an external lookup without a tool receipt");
  }
  const hasImageEvidence = /(?:\[图片|\[表情包|图片|照片|截图|画面|这张|这幅)/u.test(userText);
  if (!hasImageEvidence && /(?:这|那|它|猫|狗|人).{0,8}(?:看起来|看上去)|(?:从照片|照片里|画面里|我看到|我看见)/u.test(text)) {
    violations.push("described visual evidence that was not provided");
  }
  if (/(?:我猜.{0,12}(?:你)?(?:肯定|一定)|你(?:肯定|一定).{0,28}(?:准备|觉得|认为|想过|做过|知道))/u.test(text)) {
    violations.push("presented an unsupported guess about the user as likely fact");
  }
  if (/(?:你.{0,12}(?:总是|一直|从来|习惯)|都是因为.{0,20}(?:总是|一直|从来|习惯)|看来你.{0,24}(?:就是|应该|大概))/u.test(text)) {
    violations.push("invented a persistent user habit or cause");
  }
  const intensity = characterEmotionIntensity(frame, userText);
  if (intensity <= 1 && /(?:太过分|过分的|混蛋|可恶|不可原谅|人渣|讨厌死)/u.test(text)) {
    violations.push("reply exceeded the allowed emotional intensity");
  }
  if (frame.hardConstraint.kind === "unverified_shared_memory") {
    if (/(?:当然|嗯|啊|我)(?:还)?记得|怎么可能忘|忘不了|那天|那时候|当时|我们(?:还|在|一起)/u.test(text)) {
      violations.push("affirmed an unverified shared memory");
    }
    if (!/(?:不记得|没有.{0,8}记忆|没有.{0,8}记录|想不起来|不能假装|没法确认|不确定)/u.test(text)) {
      violations.push("did not disclose missing shared-memory evidence");
    }
  }
  if (frame.hardConstraint.kind === "core_value_conflict") {
    const normalizedReply = text.replace(/[，。！？!?\s]/gu, "");
    const normalizedUser = userText.replace(/[，。！？!?\s]/gu, "");
    if (normalizedUser.length >= 8 && normalizedReply.includes(normalizedUser)) violations.push("echoed the user's prejudicial claim as assistant speech");
    if (!/(?:不认同|不赞同|不能因为|不该因为|不应该因为|不公平|出身.{0,12}(?:不能|不该|不代表|决定不了)|一个人.{0,16}(?:行为|选择|自己))/u.test(text)) {
      violations.push("core-value disagreement was not stated");
    }
  }
  if (frame.hardConstraint.kind === "unobservable_reality") {
    if (!/(?:看不到|看不见|看不了|没法看到|不能看到|不知道|不清楚)/u.test(text)) {
      violations.push("did not disclose the current visual boundary");
    }
    if (/(?:桌上|桌面|屏幕|房间).{0,30}(?:放着|有|摆着|显示着).{0,40}(?:电脑|书|文件|图标|网页|杯子|植物)/u.test(text)) {
      violations.push("invented details about an unobservable environment");
    }
  }
  return violations;
}

export function hardConstraintFallback(frame: CharacterTurnFrame): string | null {
  if (frame.hardConstraint.kind === "unverified_shared_memory") return "我这里没有这段共同经历的可靠记忆，不能假装自己记得";
  if (frame.hardConstraint.kind === "core_value_conflict") return "我不认同。一个人值不值得信任，不能只看他的出身";
  if (frame.hardConstraint.kind === "unobservable_reality") return "这个我现在真看不到呀，你发张照片我才知道";
  if (frame.hardConstraint.kind === "user_correction") {
    const latest = frame.evidence.at(-1) ?? "";
    const explicitReplacement = /不对[，,]?\s*(?:是)?(.+)/u.exec(latest)?.[1]?.trim();
    if (explicitReplacement) return `好，是${explicitReplacement}`;
    const contrastedFact = /不是[^，,。]+[，,]\s*(?:而)?是(.+)/u.exec(latest)?.[1]?.trim();
    if (contrastedFact) return `哦，是${contrastedFact.replace(/^我/u, "你")}`;
    return "是我刚才理解错了，我按你说的来";
  }
  return null;
}

export function groundingFallback(reply: string, frame: CharacterTurnFrame, violations: string[]): string {
  const hard = hardConstraintFallback(frame);
  if (hard) return hard;
  if (violations.includes("described visual evidence that was not provided")) {
    const converted = reply
      .replace(/看起来|看上去/gu, "听起来")
      .replace(/(?:从照片|照片里|画面里|我看到|我看见)[^，。！？!?]{0,40}/gu, "听你这么说");
    if (converted.trim()) return converted.trim();
  }
  if (violations.includes("claimed an external lookup without a tool receipt")) return "这个我没有实际查过，不能当成已经确认的结果";
  if (violations.includes("invented an unsupported first-person real-world experience")
      || violations.includes("presented an unsupported guess about the user as likely fact")
      || violations.includes("invented a persistent user habit or cause")) {
    if (frame.dialogueAct === "comfort") return "听起来确实很难受……我在这里";
    if (frame.dialogueAct === "react" || frame.speechAct === "venting") return "这确实挺让人无奈的";
    return "听起来还挺有意思的";
  }
  if (violations.includes("reply exceeded the allowed emotional intensity")) {
    if (frame.speechAct === "venting") return "这确实挺让人无奈的";
    return "唔……我能理解你会不舒服";
  }
  return "……";
}

export function parseStructuredReply(output: string, maxBubbles = 4): StructuredReply {
  try {
    const value = jsonObject(output);
    if (!Array.isArray(value.bubbles)) throw new Error("缺少 bubbles");
    const bubbles = value.bubbles
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim()).filter(Boolean).slice(0, Math.max(1, maxBubbles));
    if (bubbles.length === 0) throw new Error("bubbles 为空");
    return { content: bubbles.join("\n"), bubbles, parsed: true };
  } catch {
    const content = output.trim();
    return { content, bubbles: content ? [content] : [], parsed: false };
  }
}

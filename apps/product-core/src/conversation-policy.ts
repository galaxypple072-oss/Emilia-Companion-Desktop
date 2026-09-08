import type { AgentAdapter } from "./agent.ts";
import { isExplicitLongRequest } from "./chat-format.ts";

export type ConversationMove = "react" | "acknowledge" | "opinion" | "share" | "tease" | "act" | "ask" | "quiet";
export type ConversationIntent = "casual" | "vent" | "emotional" | "question" | "task" | "detailed";

export interface ConversationPlan {
  intent: ConversationIntent;
  move: ConversationMove;
  questionBudget: 0 | 1;
  maxChars: number;
  needsClarification: boolean;
  reason: string;
}

export interface StyleFeedbackCandidate {
  category: "questions" | "verbosity" | "service_tone" | "persona" | "positive";
  sentiment: "negative" | "positive";
  instruction: string;
}

const TASK_CUE = /(?:帮我|替我|查(?:一下|下)?|看看|搜索|整理|发送|发给|创建|设置|提醒|记得|处理|读取|打开|找(?:一下|下)?)/u;
const VENT_CUE = /(?:烦死|累死|气死|无语|崩溃|受不了|他喵|妈的|又来|加活|加任务|真烦|难受|糟糕|离谱)/u;
const EMOTIONAL_CUE = /(?:难过|焦虑|害怕|孤独|委屈|伤心|不开心|压力|失眠|想哭)/u;

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.trunc(value)))
    : fallback;
}

function jsonObject(output: string): Record<string, unknown> {
  const match = /\{[\s\S]*\}/u.exec(output);
  if (!match) throw new Error("Conversation planner did not return JSON");
  return JSON.parse(match[0]) as Record<string, unknown>;
}

function isIntent(value: unknown): value is ConversationIntent {
  return typeof value === "string" && ["casual", "vent", "emotional", "question", "task", "detailed"].includes(value);
}

function isMove(value: unknown): value is ConversationMove {
  return typeof value === "string" && ["react", "acknowledge", "opinion", "share", "tease", "act", "ask", "quiet"].includes(value);
}

export function heuristicConversationPlan(userText: string, recentAssistantMessages: string[] = []): ConversationPlan {
  const text = userText.trim();
  const detailed = isExplicitLongRequest(text);
  const task = TASK_CUE.test(text);
  const emotional = EMOTIONAL_CUE.test(text);
  const vent = VENT_CUE.test(text);
  const intent: ConversationIntent = detailed ? "detailed" : task ? "task" : emotional ? "emotional" : vent ? "vent"
    : /[?？]|(?:什么|为什么|怎么|如何|多少|哪[个些]?|是否|能不能)/u.test(text) ? "question" : "casual";
  const move: ConversationMove = intent === "task" ? "act" : intent === "vent" ? "tease"
    : intent === "emotional" ? "acknowledge" : intent === "question" || intent === "detailed" ? "opinion" : "react";
  const cooldown = recentAssistantMessages.slice(-2).some((message) => /[?？]/u.test(message));
  return {
    intent,
    move,
    questionBudget: 0,
    maxChars: detailed ? 1800 : task ? 120 : 60,
    needsClarification: false,
    reason: cooldown ? "recent assistant turns already contained a question" : "default to a statement, reaction, or action",
  };
}

export function parseConversationPlan(output: string, fallback: ConversationPlan, recentAssistantMessages: string[]): ConversationPlan {
  const value = jsonObject(output);
  const proposedIntent = isIntent(value.intent) ? value.intent : fallback.intent;
  // Only deterministic, explicit action cues may enter the tool-bearing task
  // route. A dialogue model must not turn a casual description into a task,
  // because task generations deliberately survive turn supersession.
  const intent = fallback.intent === "task" ? "task" : proposedIntent === "task" ? fallback.intent : proposedIntent;
  const proposedMove = isMove(value.move) ? value.move : fallback.move;
  const move = proposedIntent === "task" && fallback.intent !== "task" ? fallback.move : proposedMove;
  const needsClarification = value.needs_clarification === true && intent === "task";
  const cooldown = recentAssistantMessages.slice(-2).some((message) => /[?？]/u.test(message));
  const curiosityEligible = value.genuine_curiosity === true
    && intent === "casual"
    && move === "ask"
    && !recentAssistantMessages.slice(-2).some((message) => /[?？]/u.test(message));
  const detailed = fallback.intent === "detailed" || intent === "detailed";
  return {
    intent,
    move: needsClarification || curiosityEligible ? "ask" : move === "ask" ? fallback.move : move,
    questionBudget: (needsClarification && !cooldown) || curiosityEligible ? 1 : 0,
    maxChars: detailed ? boundedInteger(value.max_chars, 1200, 200, 2400) : boundedInteger(value.max_chars, fallback.maxChars, 12, 120),
    needsClarification: needsClarification && !cooldown,
    reason: typeof value.reason === "string" ? value.reason.replace(/\s+/gu, " ").trim().slice(0, 160) : fallback.reason,
  };
}

export function finalBehaviorInstruction(plan: ConversationPlan, styleContext = ""): string {
  const questionRule = plan.questionBudget === 0
    ? "这一轮不需要向用户索取信息。先给自然反应或陈述，说到这里就停，不追加维持对话的问题。"
    : "这一轮可以问一个真正有用、针对当前细节的问题；问完就停，不追加第二个问题。";
  return [
    `本轮意图：${plan.intent}；主要对话动作：${plan.move}；建议长度上限：${plan.maxChars} 字。`,
    questionRule,
    plan.intent === "detailed" ? "复杂内容按清晰段落组织。" : "像即时聊天：一句能说完就只写一句；确有转折或补充时可写 2～4 个短句，每个短句单独一行，不要为了分段而凑句子。",
    "把这当成方向而不是要复述的规则。只完成主要对话动作，不解释回复策略；信息够用就停下来。",
    styleContext,
  ].filter(Boolean).join("\n");
}

function replyClauses(reply: string): string[] {
  return reply.match(/[^。！？!?…\n]+(?:…+|[。！？!?])?/gu)?.map((clause) => clause.trim()).filter(Boolean) ?? [];
}

function isImplicitQuestionClause(clause: string): boolean {
  const text = clause.trim();
  if (!text) return false;
  if (/(?:要不要|需不需要|想不想|要我(?:帮|替|陪)|需要我(?:帮|替|陪)|好吗|可以吗)/u.test(text)) return true;
  if (/(?:吗|么)[。！？!?]?$/u.test(text)) return true;
  if (/(?:是|是在)[^。！？!?]{0,40}还是[^。！？!?]{0,40}[。！？!?]?$/u.test(text)) return true;
  if (!/(?:不(?:知道|清楚|确定)|没(?:想好|弄懂))[^。！？!?]{0,12}$/u.test(text)
      && /(?:是|有|叫)[^。！？!?]{0,20}(?:什么|哪(?:个|些|里|儿)?)[^。！？!?]{0,30}[。！？!?]?$/u.test(text)) return true;
  if (/(?:什么样|哪一种|哪一只|哪一个)(?:的)?[啊呀呢吧]?[。！？!?]?$/u.test(text)) return true;
  if (/(?:是不是|有没有|难道|怎么(?:会|能|还|又|总|不)|为什么|凭什么|谁(?:会|能|知道)|怎么样)[^。！？!?]*[。！？!?]?$/u.test(text)) return true;
  if (!/(?:不(?:知道|清楚|确定)|没(?:想好|弄懂)).{0,8}(?:什么|怎么|为什么|哪|谁|多少|几)/u.test(text)
      && /(?:^|[，,……\s])(?:是|有|叫)?(?:什么|怎么|为什么|哪(?:个|些|里|儿)?|谁|多少|几(?:个|只|点|岁)?)[^。！？!?]{0,60}[。！？!?]?$/u.test(text)) return true;
  if (/(?:看起来|你|这)[^。！？!?]{0,40}(?:了|的)?吧[。！？!?]?$/u.test(text)) return true;
  return false;
}

export function reviewConversationReply(reply: string, plan: ConversationPlan): string[] {
  const violations: string[] = [];
  const questions = reply.match(/[?？]/gu)?.length ?? 0;
  if (questions > plan.questionBudget) violations.push(`question count ${questions} exceeds budget ${plan.questionBudget}`);
  if (/(?:要不要我|需不需要我|你觉得呢|怎么样呢|还有什么|想不想|可以吗|好吗)[^。！？!?]{0,12}[?？]\s*$/u.test(reply)) {
    violations.push("generic conversation-hook question ending");
  }
  if (plan.questionBudget === 0 && replyClauses(reply).some(isImplicitQuestionClause)) {
    violations.push("implicit question clause used despite zero question budget");
  }
  if (/(?:^|\n)\s*(?:intent|conversation_move|reply_max_chars|question_budget)\s*=/iu.test(reply)) {
    violations.push("internal behavior contract leaked into reply");
  }
  if (/(?:^|\n)\s*[（(＊*][^\n]{1,160}[）)＊*]/u.test(reply)) {
    violations.push("roleplay stage direction used in instant chat");
  }
  if (/[~～]/u.test(reply) || /(?:^|\n)\s*(?:喵|汪)[~～！!。.\s]*/u.test(reply)) {
    violations.push("manufactured cutesy marker used in chat");
  }
  if (plan.intent !== "detailed" && reply.length > Math.max(60, plan.maxChars)) violations.push("reply exceeds chat length budget");
  if (/(?:我理解你的感受|很高兴为你服务|还有什么可以帮你|以下是几点建议|综上所述)/u.test(reply)) violations.push("service or report tone");
  return violations;
}

function deterministicFallback(reply: string, plan: ConversationPlan): string {
  let result = reply.trim();
  if (plan.questionBudget === 0) {
    result = replyClauses(result).filter((clause) => !isImplicitQuestionClause(clause)).join("").trim();
    result = result.replace(/[?？]/gu, "。");
  }
  return result.slice(0, plan.intent === "detailed" ? 4000 : Math.max(40, plan.maxChars * 2)).trim();
}

function deterministicSanitize(reply: string, plan: ConversationPlan): string {
  let result = reply.trim();
  result = result
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(?:(?:intent|conversation_move|reply_max_chars|question_budget)\s*=)/iu.test(line))
    .join("\n")
    .trim();
  if (plan.intent !== "detailed") {
    result = result
      .replace(/(?:^|\n)\s*[（(][^（）()\n]{1,160}[）)]\s*/gu, "\n")
      .replace(/(?:^|\n)\s*[*＊][^*＊\n]{1,160}[*＊]\s*/gu, "\n")
      .replace(/(?:^|\n)\s*(?:喵|汪)[~～！!。.\s]*/gu, "\n")
      .replace(/[~～]/gu, "")
      .replace(/^\s+|\s+$/gu, "")
      .replace(/\n{3,}/gu, "\n\n");
  }
  return result;
}

export class ConversationPolicyService {
  private readonly agent: AgentAdapter | null;

  constructor(agent: AgentAdapter | null = null) {
    this.agent = agent;
  }

  async plan(userText: string, recentAssistantMessages: string[]): Promise<ConversationPlan> {
    const fallback = heuristicConversationPlan(userText, recentAssistantMessages);
    if (!this.agent) return fallback;
    try {
      const output = await this.agent.generateReply({
        systemPrompt: [
          "你是私人聊天机器人的对话动作规划器，不负责写最终回复。",
          "判断用户此刻是在闲聊、抱怨、表达情绪、提问、要求执行任务，还是明确索要详细内容。",
          "默认用反应、陈述、观点、轻微吐槽或行动推进对话，而不是提问。",
          "needs_clarification 只能在用户明确要求执行任务且缺少不可推断的关键参数，导致任务无法开始时为 true。",
          "只有用户主动分享了一个值得深入的新细节、追问本身会体现角色真实兴趣而非维持对话时，genuine_curiosity 才能为 true；它不是默认续聊手段。",
          "只输出 JSON：intent, move, needs_clarification, genuine_curiosity, max_chars, reason。",
        ].join("\n"),
        messages: [{ role: "user", content: `<USER_MESSAGE>${userText.slice(0, 4000)}</USER_MESSAGE>` }],
      });
      return parseConversationPlan(output, fallback, recentAssistantMessages);
    } catch {
      return fallback;
    }
  }

  async enforce(reply: string, plan: ConversationPlan, userText = ""): Promise<{ text: string; rewritten: boolean; violations: string[] }> {
    const sanitized = deterministicSanitize(reply, plan);
    const sanitizedChanged = sanitized !== reply.trim();
    const violations = reviewConversationReply(sanitized, plan);
    if (violations.length === 0) return { text: sanitized, rewritten: sanitizedChanged, violations: sanitizedChanged ? ["deterministic chat sanitization"] : [] };
    const deterministic = deterministicFallback(sanitized, plan);
    if (deterministic && reviewConversationReply(deterministic, plan).length === 0) {
      return { text: deterministic, rewritten: true, violations };
    }
    if (this.agent) {
      try {
        const rewritten = await this.agent.generateReply({
          systemPrompt: [
            "你是聊天回复编辑器，只修正给定草稿的风格，不添加新事实。",
            `严格遵守：question_budget=${plan.questionBudget}, max_chars=${plan.maxChars}, conversation_move=${plan.move}.`,
            "严格保持说话者关系：USER_MESSAGE 是用户说的话，DRAFT 是助手准备回复的话。不得交换‘我/你’的指代，不得把用户经历改写成助手经历，也不得凭空声称助手做过某事。",
            "保留所有工具结果、邮箱地址、文件名、行动编号、URL 和 /confirm 等命令。",
            "删除多余解释、客服套话和泛泛的续聊问题。只输出修改后的回复，不要说明修改过程。",
          ].join("\n"),
          messages: [{
            role: "user",
            content: `<USER_MESSAGE>${userText.slice(0, 4000)}</USER_MESSAGE>\n<DRAFT>${sanitized.slice(0, 4000)}</DRAFT>\n<VIOLATIONS>${violations.join("; ")}</VIOLATIONS>`,
          }],
        });
        if (reviewConversationReply(rewritten, plan).length === 0) return { text: rewritten.trim(), rewritten: true, violations };
      } catch {
        // Fall through to the deterministic safety net.
      }
    }
    return { text: deterministicFallback(sanitized, plan), rewritten: true, violations };
  }
}

export function detectStyleFeedback(text: string): StyleFeedbackCandidate[] {
  const normalized = text.replace(/\s+/gu, " ").trim().slice(0, 500);
  const feedback: StyleFeedbackCandidate[] = [];
  if (/(?:别|不要|少).{0,8}(?:问|反问)|每句.{0,8}问|问题太多|老是问|一直问/u.test(normalized)) {
    feedback.push({ category: "questions", sentiment: "negative", instruction: "减少提问；非必要时用陈述或自然反应结束。" });
  }
  if (/(?:太长|太多解释|解释太多|啰嗦|废话|少说点|简短点|(?:别|不要).{0,8}(?:展开|长篇|那么长|说太多))/u.test(normalized)) {
    feedback.push({ category: "verbosity", sentiment: "negative", instruction: "默认短答；用户未追问时不展开解释。" });
  }
  if (/(?:客服|人机|机器人|报告腔|论文腔|不像人)/u.test(normalized)) {
    feedback.push({ category: "service_tone", sentiment: "negative", instruction: "避免客服和报告腔，像熟人即时聊天。" });
  }
  if (/(?:没有少女|不像少女|人设|角色感|少女感)/u.test(normalized)) {
    feedback.push({ category: "persona", sentiment: "negative", instruction: "保留少女的即时情绪与个人判断，不靠卖萌或套话。" });
  }
  if (/(?:这样(?:说)?(?:就)?(?:挺好|很好|挺自然|自然)|这次(?:不错|挺好|挺自然|自然)|就这样说|这个感觉对)/u.test(normalized)) {
    feedback.push({ category: "positive", sentiment: "positive", instruction: "保持这次回复的简短度、节奏和自然程度。" });
  }
  return feedback;
}

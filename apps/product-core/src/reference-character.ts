import type { AgentAdapter, AgentMessage } from "./agent.ts";
import type { ConversationPlan } from "./conversation-policy.ts";

export type ReferenceDialogueAction = "acknowledge" | "react" | "answer" | "self_disclose" | "ask_one" | "correct" | "tool_handoff" | "close" | "wait";
export type ReferenceTopicPhase = "opening" | "developing" | "collecting" | "correcting" | "closing";
export const REFERENCE_NO_REPLY = "[[NO_REPLY]]";

export interface ReferenceEpisodeFrame {
  topic: string;
  phase: ReferenceTopicPhase;
  action: ReferenceDialogueAction;
  innerState: string;
  questionBudget: 0 | 1;
  waitForContinuation: boolean;
  directUserEvidence: string[];
  latestDevelopment: string;
  realityReceipts: string[];
}

const ACTIONS = new Set<ReferenceDialogueAction>(["acknowledge", "react", "answer", "self_disclose", "ask_one", "correct", "tool_handoff", "close", "wait"]);
const PHASES = new Set<ReferenceTopicPhase>(["opening", "developing", "collecting", "correcting", "closing"]);
const CORRECTION = /(?:^|[，,。！？!?\s])(?:不是|不对|我说的是|我可没说过|我没说过|我没有说|你记错了|你弄错了|说错了)|其实.{0,32}(?:还没|并没有|不是)/u;
const CONTINUATION = /^(?:还有|然后|以及|另外|再就是|等等|等一下|先别回|我还没说完)[啊呀呢吧嘛，,。.！!…\s]*$/u;
const GETTING_ACQUAINTED = /(?:互相了解|了解一下对方|介绍自己|说点我的概况|认识一下|关于我的事情|我的情况)/u;
const SELF_INTRO_REQUEST = /(?:介绍(?:一下)?你自己|你简单介绍|说说你自己|你是谁)/u;
const TOOL_REQUEST = /(?:搜一搜|搜索一下|查一下|上网查|帮我查|替我查|帮我发|替我发|请发送|现在发送)/u;
const TOPIC_CLOSE = /^(?:嗯[，,]?这样就差不多了|这样就差不多了|差不多就这些|先这样吧|就这些|聊到这吧)[。！!…\s]*$/u;

function latestUser(messages: AgentMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
}

function directEvidence(messages: AgentMessage[]): string[] {
  return messages.filter((message) => message.role === "user")
    .slice(-6)
    .map((message) => message.content.replace(/\s+/gu, " ").trim().slice(0, 300))
    .filter(Boolean);
}

function wholeTranscript(messages: AgentMessage[]): string {
  return messages.slice(-12).map((message) => `${message.role === "user" ? "用户" : "角色"}：${message.content}`).join("\n");
}

function sanitizedHint(value: unknown, fallback: string, max = 80): string {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/[\[\]{}<>\r\n]/gu, " ").replace(/\s+/gu, " ").trim();
  return text ? [...text].slice(0, max).join("") : fallback;
}

function parseJsonObject(output: string): Record<string, unknown> {
  const match = /\{[\s\S]*\}/u.exec(output);
  if (!match) throw new Error("reference planner did not return JSON");
  return JSON.parse(match[0]) as Record<string, unknown>;
}

export function fallbackReferenceEpisode(messages: AgentMessage[], plan: ConversationPlan, scenario = ""): ReferenceEpisodeFrame {
  const latest = latestUser(messages);
  const evidence = directEvidence(messages);
  const transcript = `${scenario}\n${wholeTranscript(messages)}`;
  const waitForContinuation = CONTINUATION.test(latest);
  const correcting = CORRECTION.test(latest);
  const selfIntro = SELF_INTRO_REQUEST.test(latest);
  const gettingAcquainted = GETTING_ACQUAINTED.test(transcript);
  const toolRequest = TOOL_REQUEST.test(latest);
  const closing = TOPIC_CLOSE.test(latest);
  const realityBoundary = /(?:桌上|桌面|屏幕|房间|摄像头)/u.test(latest)
    && /(?:什么|是不是|有没有|整理|看到|看见)/u.test(latest);
  const action: ReferenceDialogueAction = waitForContinuation ? "wait"
    : correcting ? "correct"
      : selfIntro ? "self_disclose"
        : toolRequest ? "tool_handoff"
          : realityBoundary ? "answer"
          : closing ? "close"
            : gettingAcquainted && plan.intent !== "question" ? "ask_one"
              : plan.intent === "question" ? "answer"
                : "react";
  const phase: ReferenceTopicPhase = waitForContinuation ? "collecting" : correcting ? "correcting" : closing ? "closing"
    : gettingAcquainted ? "developing" : messages.length <= 1 ? "opening" : "developing";
  const topic = gettingAcquainted ? "双方正在互相了解，用户在逐步介绍自己"
    : toolRequest ? "用户希望实际查询或执行工具"
      : evidence.length > 1 ? `延续同一段交流：${evidence.slice(-3).join(" / ")}`
        : `回应用户当前分享：${latest}`;
  return {
    topic: topic.slice(0, 240),
    phase,
    action,
    innerState: correcting ? "意识到自己先前理解错了，直接更新，不找借口"
      : selfIntro ? "愿意让用户认识自己，但不朗读人设档案"
        : realityBoundary ? "明确线上文字交流的现实边界，不假装看见或做过任何现实动作"
        : gettingAcquainted ? "认真听用户把一段完整的话说完，并对真正感兴趣的一点自然追问"
          : "先接住这一段对话的最新落点",
    questionBudget: action === "ask_one" ? 1 : 0,
    waitForContinuation,
    directUserEvidence: evidence,
    latestDevelopment: latest,
    realityReceipts: [],
  };
}

export class ReferenceEpisodePlanner {
  private readonly agent: AgentAdapter | null;

  constructor(agent: AgentAdapter | null) {
    this.agent = agent;
  }

  async plan(messages: AgentMessage[], plan: ConversationPlan, scenario = ""): Promise<{ frame: ReferenceEpisodeFrame; usedModel: boolean }> {
    const fallback = fallbackReferenceEpisode(messages, plan, scenario);
    if (!this.agent || fallback.waitForContinuation || ["correct", "tool_handoff", "self_disclose", "close"].includes(fallback.action)
      || /现实边界/u.test(fallback.innerState)) {
      return { frame: fallback, usedModel: false };
    }
    try {
      const output = await this.agent.generateReply({
        systemPrompt: [
          "你是陪伴型即时聊天的私有回合决策器，不写最终台词。",
          "先把最近多条消息视为一段连续交流，判断共同话题处于打开、发展、收集信息、纠正还是收尾阶段。",
          "只决定一个对话动作和一句不外显的内心倾向。不要复述角色设定，不虚构用户事实、现实观察、共同经历或工具结果。",
          "action 只能是 acknowledge, react, answer, self_disclose, ask_one, correct, tool_handoff, close。",
          "phase 只能是 opening, developing, collecting, correcting, closing。",
          "只输出 JSON：topic, phase, action, inner_state。",
        ].join("\n"),
        messages: [{ role: "user", content: JSON.stringify({ transcript: messages.slice(-12), scenario, fixed: { direct_user_evidence: fallback.directUserEvidence, max_question_budget: fallback.questionBudget } }) }],
      });
      const value = parseJsonObject(output);
      const proposedAction = ACTIONS.has(value.action as ReferenceDialogueAction) ? value.action as ReferenceDialogueAction : fallback.action;
      // A language-model planner can organize a conversation, but it cannot
      // grant itself tool authority. Only the deterministic explicit-command
      // detector may enter tool_handoff.
      const action = proposedAction === "tool_handoff" && fallback.action !== "tool_handoff"
        ? fallback.action
        : proposedAction;
      const phase = PHASES.has(value.phase as ReferenceTopicPhase) ? value.phase as ReferenceTopicPhase : fallback.phase;
      const proposedInnerState = sanitizedHint(value.inner_state, fallback.innerState);
      return {
        usedModel: true,
        frame: {
          ...fallback,
          topic: sanitizedHint(value.topic, fallback.topic, 240),
          phase,
          action: fallback.questionBudget === 0 && action === "ask_one" ? fallback.action : action,
          innerState: fallback.questionBudget === 0 && /(?:好奇|想问|追问|听更多|了解更多)/u.test(proposedInnerState)
            ? fallback.innerState
            : proposedInnerState,
          questionBudget: fallback.questionBudget,
        },
      };
    } catch {
      return { frame: fallback, usedModel: false };
    }
  }
}

export const REFERENCE_DIALOGUE_EXAMPLES = [
  "【对话风格示例】",
  "这些示例只展示节奏和事实边界，不是需要复用的固定台词。",
  "用户连续补充一件事时，等完整落点再回应，不分别评价每一句。",
  "用户纠正角色时，承认理解错了并采用新事实，不解释自己为什么会猜错。",
  "用户明确邀请彼此了解时，可以围绕当前话题问一个短问题；平常不靠问题续聊。",
  "用户询问现实环境或要求搜索时，只依据真实输入和工具回执；没有回执就坦率说尚未看到或尚未查到。",
].join("\n");

export function referencePostHistoryInstruction(frame: ReferenceEpisodeFrame): string {
  const actionRule = frame.action === "self_disclose"
    ? "自我介绍最多两条短消息：自然说名字和此刻愿意如何与用户相处。不要列举种族、头衔、王选、价值观、世界观或角色档案。"
    : frame.action === "correct"
      ? "直接承认刚才理解错了并采用用户的新说法。不要解释是记忆混淆、猜测或其他原因，不写动作。"
    : frame.action === "close"
        ? "用一句短回应自然收住，不开启新话题，不追加承诺、安排、问题或虚构动作；不要推断时间，也不要在用户没告别时擅自说晚安。"
        : frame.action === "tool_handoff"
          ? "不要生成假结果；这一动作由系统工具层处理。"
          : "围绕共同话题的最新发展回应，不逐句评价历史消息。";
  return [
    "【当前意识工作区｜不得照读】",
    `共同话题：${frame.topic}`,
    `阶段：${frame.phase}；本轮唯一动作：${frame.action}；最多提问：${frame.questionBudget}。`,
    `角色此刻的内在倾向：${frame.innerState}。它只影响语气，绝不能写成括号动作或旁白。`,
    `用户直接说过的内容：${frame.directUserEvidence.map((item) => JSON.stringify(item)).join("；") || "（无）"}`,
    `本轮最新发展：${JSON.stringify(frame.latestDevelopment)}`,
    frame.realityReceipts.length ? `工具或现实回执：${frame.realityReceipts.join("；")}` : "工具或现实回执：（无）",
    "角色设定是说话与判断的内在原因，不是自我介绍时要朗读的简历。除非用户精确询问某项资料，否则不要枚举性格、价值观、背景标签。",
    actionRule,
    "当前是纯线上文字交流。可以拥有观点、情绪和对聊天本身的心理反应；不能声称看见用户或房间、做了现实中的身体动作、拥有未记录的线下生活，或已经执行没有回执的工具。",
    "只写角色要发送的即时聊天文本，不输出工作区、动作、旁白、Markdown或解释。",
  ].join("\n");
}

export function sanitizeReferenceReply(text: string): string {
  return text
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(?:【|共同话题[：:]|阶段[：:]|本轮唯一动作[：:]|角色此刻|用户直接说过|工具或现实回执)/u.test(line))
    .join("\n")
    .replace(/[（(][^（）()\n]{0,120}(?:微微|脸|耳朵|眼睛|眼神|手|脚|身体|愣|看着|挠|走到|笑|叹气|点头|摇头|抱住|摸了)[^（）()\n]{0,80}[）)]/gu, "")
    .replace(/(?:^|\n)\s*[（(][^（）()\n]{1,160}[）)]\s*/gu, "\n")
    .replace(/[*＊][^*＊\n]{1,160}[*＊]/gu, "")
    .replace(/\n[ \t]*\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

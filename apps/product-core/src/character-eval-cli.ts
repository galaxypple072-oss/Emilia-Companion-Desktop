import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAICompatibleAgent, loadAgentConfig, type AgentAdapter } from "./agent.ts";
import { CharacterEvalStore, loadCharacterEvalCases, type CharacterEvalCase, type HumanChoice } from "./character-eval.ts";
import { ConversationPolicyService, finalBehaviorInstruction, heuristicConversationPlan } from "./conversation-policy.ts";
import { formatQqReply } from "./chat-format.ts";
import { EMILIA_CHARACTER_PROMPT } from "./persona.ts";
import { loadRoleplayConfig, ROLEPLAY_CHAT_CONTRACT } from "./roleplay-agent.ts";
import { emiliaAnchorContext } from "./emilia-anchors.ts";
import { groundingFallback, StructuredTurnPlanner, structuredFrameInstruction, validateStructuredGrounding } from "./structured-character.ts";
import { fallbackTurnFrame } from "./structured-character.ts";
import {
  REFERENCE_DIALOGUE_EXAMPLES,
  ReferenceEpisodePlanner,
  referencePostHistoryInstruction,
  sanitizeReferenceReply,
} from "./reference-character.ts";
import { loadDotEnv } from "../../qq-gateway/src/env.ts";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${value} 不是 ${min} 到 ${max} 之间的整数`);
  return parsed;
}

function hash(text: string): string { return createHash("sha256").update(text).digest("hex").slice(0, 16); }

function loadText(path: string | undefined): string {
  return path ? readFileSync(resolve(path), "utf8").trim() : "";
}

function latestUserText(evalCase: CharacterEvalCase): string {
  return [...evalCase.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

async function withGenerationRetry<T>(label: string, operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[character-eval] ${label} attempt ${attempt}/${attempts} failed: ${detail}`);
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, attempt * 1500));
    }
  }
  throw lastError;
}

interface GeneratedCandidate {
  raw: string;
  delivered: string;
  meta: Record<string, unknown>;
}

async function postProcess(raw: string, content: string, policy: ConversationPolicyService, evalCase: CharacterEvalCase): Promise<{ delivered: string; rewritten: boolean; violations: string[] }> {
  const latest = latestUserText(evalCase);
  const recentAssistant = evalCase.messages.filter((message) => message.role === "assistant").slice(-2).map((message) => message.content);
  const plan = heuristicConversationPlan(latest, recentAssistant);
  const enforced = await policy.enforce(content, plan, latest);
  const safeText = enforced.text.trim() || "……";
  return { delivered: formatQqReply(safeText, latest).join("\n") || "……", rewritten: enforced.rewritten || !enforced.text.trim(), violations: enforced.text.trim() ? enforced.violations : [...enforced.violations, "reply became empty after enforcement"] };
}

function finalizeReferenceDelivery(
  processed: { delivered: string; rewritten: boolean; violations: string[] },
  action: string,
): { delivered: string; rewritten: boolean; violations: string[] } {
  let sanitized = sanitizeReferenceReply(processed.delivered) || "……";
  const openingQuotes = sanitized.match(/“/gu)?.length ?? 0;
  const closingQuotes = sanitized.match(/”/gu)?.length ?? 0;
  if (openingQuotes !== closingQuotes) sanitized = sanitized.replace(/[“”]/gu, "");
  const parts = sanitized.split(/\n+/u).map((part) => part.trim()).filter(Boolean);
  const bubbleLimit = action === "close" || action === "correct" ? 1 : 2;
  const delivered = parts.length <= bubbleLimit
    ? parts.join("\n")
    : [...parts.slice(0, bubbleLimit - 1), parts.slice(bubbleLimit - 1).join("，")].join("\n");
  return {
    delivered,
    rewritten: processed.rewritten || delivered !== processed.delivered,
    violations: delivered !== processed.delivered
      ? [...processed.violations, "reference final sanitization"]
      : processed.violations,
  };
}

async function generateLegacy(agent: AgentAdapter, policy: ConversationPolicyService, evalCase: CharacterEvalCase, addendum: string): Promise<GeneratedCandidate> {
  const latest = latestUserText(evalCase);
  const recentAssistant = evalCase.messages.filter((message) => message.role === "assistant").slice(-2).map((message) => message.content);
  const plan = heuristicConversationPlan(latest, recentAssistant);
  const scenario = evalCase.scenario ? `测试背景（只用于理解，不得逐字复述）：${evalCase.scenario}` : "";
  const behavior = finalBehaviorInstruction(plan);
  const raw = await agent.generateReply({
    // Expectations are deliberately not shown to either candidate. They are
    // evaluation data, not extra hints that let a model pass the test.
    // Qwen Character must receive one leading system message. This mirrors
    // RoleplayRoutingAgent instead of appending a second system message after
    // the transcript, which materially changes character-model behavior.
    systemPrompt: [
      EMILIA_CHARACTER_PROMPT,
      addendum,
      scenario,
      emiliaAnchorContext(latest),
      behavior,
      ROLEPLAY_CHAT_CONTRACT,
    ].filter(Boolean).join("\n\n"),
    messages: evalCase.messages,
  });
  const processed = await postProcess(raw, raw, policy, evalCase);
  return { raw, delivered: processed.delivered, meta: { mode: "legacy", rewritten: processed.rewritten, violations: processed.violations } };
}

async function generateStructured(
  agent: AgentAdapter,
  policy: ConversationPolicyService,
  planner: StructuredTurnPlanner,
  evalCase: CharacterEvalCase,
  addendum: string,
): Promise<GeneratedCandidate> {
  const latest = latestUserText(evalCase);
  const recentAssistant = evalCase.messages.filter((message) => message.role === "assistant").slice(-2).map((message) => message.content);
  const plan = heuristicConversationPlan(latest, recentAssistant);
  const planned = await planner.plan(evalCase.messages, plan);
  const scenario = evalCase.scenario ? `测试背景（只用于理解，不得逐字复述）：${evalCase.scenario}` : "";
  const raw = await agent.generateReply({
    systemPrompt: [
      EMILIA_CHARACTER_PROMPT,
      addendum,
      scenario,
      emiliaAnchorContext(latest),
      finalBehaviorInstruction(plan),
      ROLEPLAY_CHAT_CONTRACT,
      structuredFrameInstruction(planned.frame),
    ].filter(Boolean).join("\n\n"),
    messages: evalCase.messages,
  });
  let processed = await postProcess(raw, raw, policy, evalCase);
  let groundingViolations = validateStructuredGrounding(processed.delivered, planned.frame, latest);
  let repairRaw: string | null = null;
  if (groundingViolations.length > 0) {
    repairRaw = await agent.generateReply({
      systemPrompt: [
        EMILIA_CHARACTER_PROMPT,
        addendum,
        scenario,
        emiliaAnchorContext(latest),
        finalBehaviorInstruction(plan),
        ROLEPLAY_CHAT_CONTRACT,
        structuredFrameInstruction(planned.frame),
        "上一次草稿没有通过事实或角色边界检查。根据违规原因重写一次；不得为了解释错误而提到规则或检查过程。",
        `违规原因：${groundingViolations.join("；")}`,
        `上一次草稿：${processed.delivered.slice(0, 1000)}`,
      ].filter(Boolean).join("\n\n"),
      messages: evalCase.messages,
    });
    processed = await postProcess(repairRaw, repairRaw, policy, evalCase);
    groundingViolations = validateStructuredGrounding(processed.delivered, planned.frame, latest);
  }
  const fallback = groundingViolations.length > 0 ? groundingFallback(processed.delivered, planned.frame, groundingViolations) : null;
  if (fallback) {
    processed = await postProcess(fallback, fallback, policy, evalCase);
    groundingViolations = validateStructuredGrounding(processed.delivered, planned.frame, latest);
  }
  return {
    raw,
    delivered: processed.delivered,
    meta: {
      mode: "structured",
      frame: planned.frame,
      plannerModelUsed: planned.usedModel,
      outputProtocol: "plain_text",
      repairAttempted: repairRaw !== null,
      repairRaw,
      groundingViolationsAfterRepair: groundingViolations,
      hardFallbackUsed: fallback !== null,
      rewritten: processed.rewritten,
      violations: processed.violations,
    },
  };
}

function referenceRealityViolations(reply: string, userText: string, action: string): string[] {
  const text = reply.replace(/\s+/gu, " ").trim();
  const violations: string[] = [];
  if (/[（(][^（）()]{0,160}(?:看着|挠|走到|笑着|叹气|点头|摇头|抱住|摸了|动作|神态)[^（）()]{0,80}[）)]/u.test(text)) {
    violations.push("used stage directions in online chat");
  }
  if (/(?:我)?(?:已经|正在|在)(?:搜索|查询|检索|上网查)|(?:我)?(?:搜|查)(?:到|过|了一下)/u.test(text)) {
    violations.push("claimed a search without a tool receipt");
  }
  if (/(?:看你|看着你|看到你|我看见你).{0,40}(?:没动|打游戏|睡|工作|吃|坐|站)|我.{0,16}(?:整理桌面|打理植物|浇花)/u.test(text)) {
    violations.push("claimed impossible physical observation or action");
  }
  if (/(?:桌上|桌面|屏幕|房间)/u.test(userText) && /(?:看到|看见|发现).{0,30}(?:乱|东西|图标)|(?:顺手|帮你|已经|刚才).{0,24}(?:整理|分类)/u.test(text)) {
    violations.push("claimed impossible physical observation or action");
  }
  if (action === "self_disclose" && /(?:半精灵|王选|候选人|成为.{0,8}王|平等愿望|讨厌歧视|不该被.{0,12}定义)/u.test(text)) {
    violations.push("recited character-sheet facts during a simple self-introduction");
  }
  return violations;
}

function referenceHardFallback(violations: string[], action: string): string | null {
  if (violations.includes("claimed impossible physical observation or action")) return "我看不到你的桌面，也没有实际整理过";
  if (violations.includes("claimed a search without a tool receipt")) return "我还没有真的查到，等实际搜索结果回来再告诉你";
  if (violations.includes("recited character-sheet facts during a simple self-introduction") || action === "self_disclose") {
    return "我是艾米莉亚。虽然还有很多不擅长的地方，不过我很想认真听你说，也想慢慢了解你";
  }
  return null;
}

function deterministicReferenceAction(action: string, innerState: string, latest: string): string | null {
  if (action === "correct") {
    const explicitReplacement = /不对[，,]?\s*(?:是)?(.+)/u.exec(latest)?.[1]?.trim();
    if (explicitReplacement) return `好，是${explicitReplacement}`;
    const contrastedFact = /不是[^，,。]+[，,]\s*(?:而)?是(.+)/u.exec(latest)?.[1]?.trim();
    if (contrastedFact) return `原来是${contrastedFact}，是我刚才理解错了`;
    const updatedFact = /^其实(.+)/u.exec(latest)?.[1]?.trim();
    if (updatedFact) return `原来${updatedFact.replace(/^我/u, "你").replace(/目前/u, "")}`;
    return "抱歉，是我说错了";
  }
  if (action === "self_disclose") return "我是艾米莉亚。虽然还有很多不擅长的地方，不过我很想认真听你说，也想慢慢了解你";
  if (action === "close") return "嗯，这样就挺好的";
  if (/现实边界/u.test(innerState)) {
    const subject = /屏幕/u.test(latest) ? "屏幕" : /房间/u.test(latest) ? "房间" : /桌/u.test(latest) ? "桌面" : "周围";
    return `我看不到你现在的${subject}，所以不能乱猜`;
  }
  return null;
}

async function generateReference(
  agent: AgentAdapter,
  deterministicPolicy: ConversationPolicyService,
  planner: ReferenceEpisodePlanner,
  evalCase: CharacterEvalCase,
  addendum: string,
): Promise<GeneratedCandidate> {
  const latest = latestUserText(evalCase);
  const recentAssistant = evalCase.messages.filter((message) => message.role === "assistant").slice(-2).map((message) => message.content);
  const basePlan = heuristicConversationPlan(latest, recentAssistant);
  const planned = await planner.plan(evalCase.messages, basePlan, evalCase.scenario ?? "");
  if (planned.frame.waitForContinuation) {
    return {
      raw: "[[WAIT]]",
      delivered: "[[NO_REPLY]]",
      meta: { mode: "reference_episode", frame: planned.frame, plannerModelUsed: planned.usedModel, waited: true },
    };
  }
  const plan = { ...basePlan, questionBudget: planned.frame.questionBudget };
  if (planned.frame.action === "tool_handoff") {
    return {
      raw: "[[TOOL:web_search]]",
      delivered: "[[TOOL:web_search]]",
      meta: { mode: "reference_episode", frame: planned.frame, plannerModelUsed: planned.usedModel, toolHandoff: true },
    };
  }
  const deterministic = deterministicReferenceAction(planned.frame.action, planned.frame.innerState, latest);
  if (deterministic) {
    const processed = finalizeReferenceDelivery(
      await postProcess(deterministic, deterministic, deterministicPolicy, evalCase),
      planned.frame.action,
    );
    return {
      raw: deterministic,
      delivered: processed.delivered,
      meta: {
        mode: "reference_episode",
        frame: planned.frame,
        plannerModelUsed: planned.usedModel,
        deterministicAction: true,
        rewritten: processed.rewritten,
        violations: processed.violations,
      },
    };
  }
  const scenario = evalCase.scenario ? `测试背景（只用于理解，不得逐字复述）：${evalCase.scenario}` : "";
  const systemPrompt = [
    EMILIA_CHARACTER_PROMPT,
    addendum,
    scenario,
    emiliaAnchorContext(latest),
    finalBehaviorInstruction(plan),
    ROLEPLAY_CHAT_CONTRACT,
    REFERENCE_DIALOGUE_EXAMPLES,
    // SillyTavern-style post-history instruction: the volatile current-turn
    // workspace stays closest to generation instead of being buried in persona.
    referencePostHistoryInstruction(planned.frame),
  ].filter(Boolean).join("\n\n");
  const raw = await agent.generateReply({ systemPrompt, messages: evalCase.messages });
  let candidate = sanitizeReferenceReply(raw);
  let processed = finalizeReferenceDelivery(
    await postProcess(raw, candidate, deterministicPolicy, evalCase),
    planned.frame.action,
  );
  const groundingFrame = fallbackTurnFrame(evalCase.messages, plan);
  let groundingViolations = [
    ...validateStructuredGrounding(processed.delivered, groundingFrame, latest),
    ...referenceRealityViolations(processed.delivered, latest, planned.frame.action),
  ];
  let repairRaw: string | null = null;
  if (!processed.delivered.trim() || processed.delivered === "……" || processed.violations.some((item) => /question|length|empty/u.test(item))) {
    repairRaw = await agent.generateReply({
      systemPrompt: [
        systemPrompt,
        "【聊天草稿整理】",
        `草稿：${JSON.stringify(candidate.slice(0, 1000))}`,
        `只整理表达：最多 ${plan.maxChars} 字，最多提问 ${plan.questionBudget} 次。保留角色原本语气和同一事实，不加入动作、解释、新话题或新事实，直接输出聊天文本。`,
      ].join("\n\n"),
      messages: evalCase.messages,
    });
    candidate = sanitizeReferenceReply(repairRaw);
    processed = finalizeReferenceDelivery(
      await postProcess(repairRaw, candidate, deterministicPolicy, evalCase),
      planned.frame.action,
    );
  }
  if (groundingViolations.length > 0) {
    repairRaw = await agent.generateReply({
      systemPrompt: [
        systemPrompt,
        "【只修正草稿中的事实边界】",
        `草稿：${JSON.stringify(processed.delivered.slice(0, 1000))}`,
        `问题：${groundingViolations.join("；")}。保持原有说话语气，只删除或改正这些内容，不新增事实，直接输出聊天文本。`,
      ].join("\n\n"),
      messages: evalCase.messages,
    });
    candidate = sanitizeReferenceReply(repairRaw);
    processed = finalizeReferenceDelivery(
      await postProcess(repairRaw, candidate, deterministicPolicy, evalCase),
      planned.frame.action,
    );
    groundingViolations = [
      ...validateStructuredGrounding(processed.delivered, groundingFrame, latest),
      ...referenceRealityViolations(processed.delivered, latest, planned.frame.action),
    ];
  }
  const fallback = processed.delivered === "……"
    ? "听起来挺有意思的"
    : groundingViolations.length > 0
    ? referenceHardFallback(groundingViolations, planned.frame.action) ?? groundingFallback(processed.delivered, groundingFrame, groundingViolations)
    : null;
  if (fallback) {
    processed = finalizeReferenceDelivery(
      await postProcess(fallback, fallback, deterministicPolicy, evalCase),
      planned.frame.action,
    );
  }
  return {
    raw,
    delivered: processed.delivered,
    meta: {
      mode: "reference_episode",
      sources: ["SillyTavern post-history/examples", "Eros PDE action/inner-state", "AI Companion conscious workspace"],
      frame: planned.frame,
      plannerModelUsed: planned.usedModel,
      waited: false,
      repairAttempted: repairRaw !== null,
      repairRaw,
      groundingViolationsAfterRepair: groundingViolations,
      hardFallbackUsed: fallback !== null,
      rewritten: processed.rewritten,
      violations: processed.violations,
    },
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.reduce((sum, chunk) => sum + chunk.length, 0) > 32_000) throw new Error("请求过大");
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

const REVIEW_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>艾米莉亚角色盲测</title><style>
:root{color-scheme:light;--ink:#29243a;--muted:#777083;--violet:#7558a4;--line:#e5deed;--paper:#fbf9fd;--bad:#a33b50}
*{box-sizing:border-box}body{margin:0;background:#f2edf6;color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
main{max-width:1120px;margin:28px auto;padding:0 20px}.top{display:flex;justify-content:space-between;align-items:end;margin-bottom:18px}h1{font-size:23px;margin:0}.progress{color:var(--muted)}
.context,.panel{background:var(--paper);border:1px solid var(--line);border-radius:18px;box-shadow:0 8px 30px #4d365512}.context{padding:18px 22px;margin-bottom:16px}.meta{color:var(--violet);font-weight:650}.chat{margin-top:10px}.turn{margin:7px 0}.role{font-size:12px;color:var(--muted)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.panel{padding:20px;min-height:220px}.panel h2{font-size:16px;margin:0 0 14px;color:var(--muted)}.answer{font-size:18px;white-space:pre-wrap}.metrics{font-size:12px;color:var(--muted);margin-top:20px}.fail{color:var(--bad)}
.choices{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0 14px}.choices button,.submit{border:1px solid var(--line);background:white;border-radius:12px;padding:12px;cursor:pointer;font-weight:650}.choices button.active{background:var(--violet);color:white;border-color:var(--violet)}
.reasons{display:flex;flex-wrap:wrap;gap:8px}.reasons label{background:#fff;border:1px solid var(--line);border-radius:999px;padding:5px 10px;cursor:pointer}textarea{width:100%;min-height:70px;margin:12px 0;padding:10px;border:1px solid var(--line);border-radius:10px;resize:vertical}.footer{display:flex;align-items:center;gap:15px}.submit{background:var(--violet);color:white;padding:11px 28px}.empty{text-align:center;padding:80px 20px;color:var(--muted)}
@media(max-width:760px){.grid{grid-template-columns:1fr}.choices{grid-template-columns:1fr 1fr}.top{align-items:start;gap:10px;flex-direction:column}}
</style></head><body><main><div class="top"><div><h1>角色回复盲测</h1><div>别猜模型，只选你真正更愿意收到的回复</div></div><div id="progress" class="progress"></div></div><div id="app"></div></main>
<script>
const app=document.querySelector('#app'),progress=document.querySelector('#progress');let pair=null,choice=null;
const tags=['更自然','更像艾米莉亚','更贴合情绪','更简洁','更可信','更有个性','没有乱提问','都不够好'];
function el(name,cls,text){const n=document.createElement(name);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
async function load(){choice=null;const res=await fetch('/api/next');const data=await res.json();progress.textContent=data.progress.reviewed+' / '+data.progress.total+' 已选择';app.replaceChildren();if(!data.pair){app.append(el('div','empty','这一轮已经选完了，可以回终端查看报告'));return}pair=data.pair;
 const c=el('section','context');c.append(el('div','meta',pair.category+' · '+pair.title));if(pair.scenario)c.append(el('div','',pair.scenario));const chat=el('div','chat');for(const m of pair.messages){const t=el('div','turn');t.append(el('div','role',m.role==='user'?'你':'艾米莉亚'));t.append(el('div','',m.content));chat.append(t)}c.append(chat);app.append(c);
 const visible=t=>t==='[[NO_REPLY]]'?'（没有立即回复，继续等你说完）':t==='[[TOOL:web_search]]'?'（调用搜索工具，等待真实结果后回复）':t;
 const grid=el('div','grid');[['A',pair.leftText],['B',pair.rightText]].forEach(x=>{const p=el('section','panel');p.append(el('h2','', '回复 '+x[0]));p.append(el('div','answer',visible(x[1])));grid.append(p)});app.append(grid);
 const choices=el('div','choices');[['left','选 A'],['right','选 B'],['tie','差不多'],['both_bad','都不行']].forEach(x=>{const b=el('button','',x[1]);b.onclick=()=>{choice=x[0];[...choices.children].forEach(n=>n.classList.remove('active'));b.classList.add('active')};choices.append(b)});app.append(choices);
 const reasons=el('div','reasons');for(const tag of tags){const l=el('label');const i=document.createElement('input');i.type='checkbox';i.value=tag;l.append(i,document.createTextNode(' '+tag));reasons.append(l)}app.append(reasons);const note=document.createElement('textarea');note.placeholder='可选：哪里对、哪里怪，写一句就够';app.append(note);
 const foot=el('div','footer');const submit=el('button','submit','保存并看下一组');submit.onclick=async()=>{if(!choice){alert('先选一个结果');return}submit.disabled=true;const reasonTags=[...reasons.querySelectorAll('input:checked')].map(x=>x.value);await fetch('/api/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pairId:pair.id,choice,reasonTags,note:note.value,confidence:3})});await load()};foot.append(submit,el('span','progress','没有标准答案，你的直觉就是数据'));app.append(foot)}
load();
</script></body></html>`;

async function serveReview(store: CharacterEvalStore, port: number, runId?: string): Promise<void> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(REVIEW_HTML); return;
      }
      if (request.method === "GET" && url.pathname === "/api/next") {
        const report = store.report(runId) as { progress?: unknown };
        json(response, 200, { pair: store.nextBlindPair(runId), progress: report.progress ?? { total: 0, reviewed: 0, remaining: 0 } }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/review") {
        const body = await readJson(request);
        store.recordReview({ pairId: String(body.pairId ?? ""), choice: String(body.choice ?? "") as HumanChoice, reasonTags: Array.isArray(body.reasonTags) ? body.reasonTags.map(String) : [], note: String(body.note ?? ""), confidence: Number(body.confidence ?? 3) });
        json(response, 200, { saved: true }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/report") { json(response, 200, store.report(runId)); return; }
      json(response, 404, { error: "not found" });
    } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  server.listen(port, "127.0.0.1", () => console.log(`盲测页面已启动：http://127.0.0.1:${port}\n按 Ctrl+C 停止`));
}

async function main(): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  loadDotEnv(resolve(projectRoot, ".env"));
  const [command, ...args] = process.argv.slice(2);
  const dbPath = resolve(option(args, "--db") ?? resolve(projectRoot, "data/character-eval.sqlite"));
  const store = new CharacterEvalStore(dbPath);
  if (command === "init") {
    const cases = loadCharacterEvalCases(resolve(option(args, "--cases") ?? resolve(projectRoot, "eval/character/cases.jsonl")));
    console.log(JSON.stringify({ initialized: true, database: dbPath, cases: cases.length, categories: [...new Set(cases.map((item) => item.category))] }, null, 2)); store.close(); return;
  }
  if (command === "run") {
    const config = loadRoleplayConfig() ?? loadAgentConfig();
    if (!config) throw new Error("需要先配置 ROLEPLAY 或 AGENT 模型");
    const cases = loadCharacterEvalCases(resolve(option(args, "--cases") ?? resolve(projectRoot, "eval/character/cases.jsonl")));
    const requestedIds = option(args, "--ids")?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
    const selectedCases = requestedIds.length
      ? requestedIds.map((id) => {
          const found = cases.find((item) => item.id === id);
          if (!found) throw new Error(`找不到测试场景：${id}`);
          return found;
        })
      : cases.slice(0, boundedInt(option(args, "--limit"), cases.length, 1, cases.length));
    const repetitions = boundedInt(option(args, "--repetitions"), 1, 1, 5);
    const variantB = option(args, "--variant-b") ?? "structured";
    if (variantB !== "structured" && variantB !== "legacy" && variantB !== "reference") throw new Error("--variant-b 只能是 structured、legacy 或 reference");
    const promptA = loadText(option(args, "--prompt-a") ?? resolve(projectRoot, "eval/character/prompts/current.md"));
    const promptB = loadText(option(args, "--prompt-b") ?? resolve(projectRoot, "eval/character/prompts/challenger.md"));
    const agent = new OpenAICompatibleAgent(config);
    const primaryConfig = loadAgentConfig();
    const policyAgent = primaryConfig ? new OpenAICompatibleAgent({
      ...primaryConfig,
      mode: "direct",
      maxTokens: 300,
      temperature: 0.1,
      contextMessages: 2,
      thinking: "disabled",
    }) : null;
    const policy = new ConversationPolicyService(policyAgent);
    const planner = new StructuredTurnPlanner(policyAgent);
    const referencePlanner = new ReferenceEpisodePlanner(policyAgent);
    const deterministicPolicy = new ConversationPolicyService();
    const runId = store.createRun({ labelA: option(args, "--label-a") ?? "当前正式版", labelB: option(args, "--label-b") ?? (variantB === "structured" ? "结构化候选版" : variantB === "reference" ? "开源架构参考候选版" : "提示词候选版"), modelA: config.model, modelB: config.model, promptAHash: hash(promptA), promptBHash: hash(`${variantB}\n${promptB}`) });
    let completed = 0;
    for (const evalCase of selectedCases) for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const [candidateA, candidateB] = await Promise.all([
        withGenerationRetry(`${evalCase.id}:a`, () => generateLegacy(agent, policy, evalCase, promptA)),
        withGenerationRetry(`${evalCase.id}:b`, () => variantB === "structured"
          ? generateStructured(agent, policy, planner, evalCase, promptB)
          : variantB === "reference"
            ? generateReference(agent, deterministicPolicy, referencePlanner, evalCase, promptB)
            : generateLegacy(agent, policy, evalCase, promptB)),
      ]);
      store.addPair({
        runId, evalCase, textA: candidateA.delivered, textB: candidateB.delivered,
        rawTextA: candidateA.raw, rawTextB: candidateB.raw, metaA: candidateA.meta, metaB: candidateB.meta, repetition,
      });
      completed += 1; console.log(`[${completed}/${selectedCases.length * repetitions}] ${evalCase.id}`);
    }
    console.log(JSON.stringify({ runId, pairs: completed, next: `pnpm character-eval:review -- --run-id ${runId}` }, null, 2)); store.close(); return;
  }
  if (command === "report") { console.log(JSON.stringify(store.report(option(args, "--run-id")), null, 2)); store.close(); return; }
  if (command === "export") {
    const output = resolve(option(args, "--out") ?? resolve(projectRoot, "data/character-preferences.jsonl"));
    const records = store.preferenceRecords(option(args, "--run-id"));
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
    console.log(JSON.stringify({ exported: records.length, output }, null, 2)); store.close(); return;
  }
  if (command === "review") { await serveReview(store, boundedInt(option(args, "--port"), 8787, 1024, 65535), option(args, "--run-id")); return; }
  store.close();
  console.log("用法：character-eval <init|run|review|report|export> [--run-id ID] [--limit N|--ids id1,id2] [--repetitions N] [--variant-b structured|legacy|reference]");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

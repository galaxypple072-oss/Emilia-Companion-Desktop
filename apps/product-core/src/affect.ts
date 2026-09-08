import type { ProductStore } from "./store.ts";

export type DominantEmotion = "neutral" | "joyful" | "concerned" | "shy" | "surprised" | "irritated" | "sad" | "thoughtful";
export type RelationshipStage = "initial" | "familiar" | "close" | "attuned";

export interface RelationshipState {
  familiarity: number;
  trust: number;
  affection: number;
  rapport: number;
  stage: RelationshipStage;
}

export interface AffectiveState {
  version: 1;
  emotion: DominantEmotion;
  valence: number;
  arousal: number;
  intensity: number;
  relationship: RelationshipState;
  updatedAt: number;
}

export interface RelationshipDelta {
  familiarity: number;
  trust: number;
  affection: number;
  rapport: number;
}

export interface AffectAppraisal {
  emotion: DominantEmotion;
  valenceDelta: number;
  arousalDelta: number;
  intensity: number;
  relationship: RelationshipDelta;
  reason: string;
}

export interface AffectExpression {
  emotion: "neutral" | "happy" | "concerned" | "think" | "surprise" | "shy" | "angry" | "sad";
  intensity: number;
  motion: "Idle" | "Smile" | "Think" | "Surprise" | "Shy" | "Angry";
}

const HALF_LIFE_MS = 30 * 60_000;
const ZERO_DELTA: RelationshipDelta = { familiarity: 0, trust: 0, affection: 0, rapport: 0 };

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function relationshipStage(relationship: Omit<RelationshipState, "stage">): RelationshipStage {
  const score = relationship.familiarity * 0.3 + relationship.trust * 0.3 + relationship.affection * 0.2 + relationship.rapport * 0.2;
  if (score >= 0.72) return "attuned";
  if (score >= 0.5) return "close";
  if (score >= 0.3) return "familiar";
  return "initial";
}

export function initialAffectiveState(now = Date.now()): AffectiveState {
  return {
    version: 1,
    emotion: "neutral",
    valence: 0,
    arousal: 0.12,
    intensity: 0,
    relationship: {
      familiarity: 0.08,
      trust: 0.28,
      affection: 0.12,
      rapport: 0.08,
      stage: "initial",
    },
    updatedAt: now,
  };
}

export function decayAffectiveState(state: AffectiveState, now = Date.now()): AffectiveState {
  const elapsed = Math.max(0, now - state.updatedAt);
  if (elapsed === 0) return structuredClone(state);
  const factor = 0.5 ** (elapsed / HALF_LIFE_MS);
  const intensity = clamp(state.intensity * factor);
  return {
    ...state,
    emotion: intensity < 0.08 ? "neutral" : state.emotion,
    valence: Math.max(-1, Math.min(1, state.valence * factor)),
    arousal: clamp(0.12 + (state.arousal - 0.12) * factor),
    intensity,
    relationship: { ...state.relationship },
    updatedAt: now,
  };
}

function appraisal(overrides: Partial<AffectAppraisal>): AffectAppraisal {
  return {
    emotion: overrides.emotion ?? "neutral",
    valenceDelta: overrides.valenceDelta ?? 0,
    arousalDelta: overrides.arousalDelta ?? 0,
    intensity: overrides.intensity ?? 0.15,
    relationship: { ...ZERO_DELTA, ...overrides.relationship },
    reason: overrides.reason ?? "ordinary conversation",
  };
}

export function appraiseUserMessage(text: string): AffectAppraisal {
  const value = text.replace(/\s+/gu, " ").trim().slice(0, 4000);
  const baseFamiliarity = 0.0008;
  if (/(?:难受|想哭|委屈|伤心|害怕|焦虑|孤独|压力很大|撑不住|失眠)/u.test(value)) {
    return appraisal({ emotion: "concerned", valenceDelta: -0.28, arousalDelta: 0.22, intensity: 0.72, relationship: { ...ZERO_DELTA, familiarity: 0.003, trust: 0.004, affection: 0.003 }, reason: "user shared distress" });
  }
  if (/(?:我其实|告诉你一个|没和别人说|我的秘密|说实话|我最近|我小时候)/u.test(value)) {
    return appraisal({ emotion: "concerned", valenceDelta: -0.08, arousalDelta: 0.12, intensity: 0.48, relationship: { ...ZERO_DELTA, familiarity: 0.006, trust: 0.007, affection: 0.002 }, reason: "personal disclosure" });
  }
  if (/(?:喜欢你|想你了|有你真好|最喜欢|爱你)/u.test(value)) {
    return appraisal({ emotion: "shy", valenceDelta: 0.35, arousalDelta: 0.3, intensity: 0.78, relationship: { ...ZERO_DELTA, familiarity: 0.002, trust: 0.002, affection: 0.008, rapport: 0.003 }, reason: "direct affection" });
  }
  if (/(?:谢谢|辛苦了|做得不错|这样很好|效果很好|挺自然|好厉害)/u.test(value)) {
    return appraisal({ emotion: "joyful", valenceDelta: 0.28, arousalDelta: 0.14, intensity: 0.55, relationship: { ...ZERO_DELTA, familiarity: 0.002, trust: 0.003, affection: 0.002, rapport: 0.005 }, reason: "positive feedback" });
  }
  if (/(?:哈哈|笑死|好耶|太好了|开心)/u.test(value)) {
    return appraisal({ emotion: "joyful", valenceDelta: 0.26, arousalDelta: 0.22, intensity: 0.58, relationship: { ...ZERO_DELTA, familiarity: 0.002, affection: 0.0015, rapport: 0.003 }, reason: "shared positive emotion" });
  }
  if (/(?:你(?:真|也)?(?:笨|蠢|烦)|讨厌你|别装了)/u.test(value)) {
    return appraisal({ emotion: "irritated", valenceDelta: -0.2, arousalDelta: 0.25, intensity: 0.5, relationship: { ...ZERO_DELTA, familiarity: baseFamiliarity }, reason: "directed frustration without relationship punishment" });
  }
  if (/(?:不是这样|你理解错了|又错了|别.{0,8}(?:解释|追问|这么说)|太人机|不像人)/u.test(value)) {
    return appraisal({ emotion: "thoughtful", valenceDelta: -0.05, arousalDelta: 0.08, intensity: 0.38, relationship: { ...ZERO_DELTA, familiarity: 0.0015, trust: 0.001, rapport: 0.002 }, reason: "corrective feedback treated as useful guidance" });
  }
  if (/[!！]{2,}|(?:居然|真的假的|不会吧|出事了|突然)/u.test(value)) {
    return appraisal({ emotion: "surprised", valenceDelta: 0.02, arousalDelta: 0.38, intensity: 0.62, relationship: { ...ZERO_DELTA, familiarity: baseFamiliarity }, reason: "surprising event" });
  }
  if (/[?？]|(?:帮我|看看|查一下|怎么|为什么|能不能)/u.test(value)) {
    return appraisal({ emotion: "thoughtful", arousalDelta: 0.08, intensity: 0.3, relationship: { ...ZERO_DELTA, familiarity: baseFamiliarity, rapport: 0.0005 }, reason: "question or task" });
  }
  return appraisal({ emotion: "neutral", intensity: 0.14, relationship: { ...ZERO_DELTA, familiarity: baseFamiliarity, rapport: 0.0003 } });
}

export function evolveAffectiveState(current: AffectiveState, event: AffectAppraisal, now = Date.now()): AffectiveState {
  const state = decayAffectiveState(current, now);
  const nextRelationship = {
    familiarity: clamp(state.relationship.familiarity + event.relationship.familiarity * (1 - state.relationship.familiarity)),
    trust: clamp(state.relationship.trust + event.relationship.trust * (1 - state.relationship.trust)),
    affection: clamp(state.relationship.affection + event.relationship.affection * (1 - state.relationship.affection)),
    rapport: clamp(state.relationship.rapport + event.relationship.rapport * (1 - state.relationship.rapport)),
  };
  const intensity = clamp(Math.max(state.intensity * 0.68, event.intensity));
  return {
    version: 1,
    emotion: event.intensity >= state.intensity * 0.7 ? event.emotion : state.emotion,
    valence: Math.max(-1, Math.min(1, state.valence * 0.72 + event.valenceDelta)),
    arousal: clamp(state.arousal * 0.72 + event.arousalDelta),
    intensity,
    relationship: { ...nextRelationship, stage: relationshipStage(nextRelationship) },
    updatedAt: now,
  };
}

function intensityLabel(value: number): string {
  if (value >= 0.7) return "明显";
  if (value >= 0.38) return "中等";
  return "轻微";
}

const EMOTION_LABELS: Record<DominantEmotion, string> = {
  neutral: "平静", joyful: "愉快", concerned: "担心", shy: "害羞", surprised: "惊讶", irritated: "轻微不满", sad: "难过", thoughtful: "认真思考",
};

const STAGE_GUIDANCE: Record<RelationshipStage, string> = {
  initial: "仍在互相了解，表达自然但保持适度分寸。",
  familiar: "已经熟悉，可以更随意地接话并引用共同经历。",
  close: "关系亲近，可以自然关心、轻微玩笑，不要刻意撒娇。",
  attuned: "已有默契，优先理解潜台词并减少不必要解释。",
};

export function affectPromptContext(state: AffectiveState): string {
  return [
    "内部情绪与关系状态（只影响表达和判断，绝不能向用户展示数值、阶段名或解释状态机制）：",
    `当前情绪：${EMOTION_LABELS[state.emotion]}，强度${intensityLabel(state.intensity)}。`,
    `关系表达指引：${STAGE_GUIDANCE[state.relationship.stage]}`,
    "情绪应体现为措辞、节奏和细微态度，不要直接宣布‘我现在很开心/好感度增加’，也不要用冷落、嫉妒或内疚操纵用户。",
  ].join("\n");
}

export function affectExpression(state: AffectiveState): AffectExpression {
  const mapping: Record<DominantEmotion, Pick<AffectExpression, "emotion" | "motion">> = {
    neutral: { emotion: "neutral", motion: "Idle" },
    joyful: { emotion: "happy", motion: "Smile" },
    concerned: { emotion: "concerned", motion: "Think" },
    shy: { emotion: "shy", motion: "Shy" },
    surprised: { emotion: "surprise", motion: "Surprise" },
    irritated: { emotion: "angry", motion: "Angry" },
    sad: { emotion: "sad", motion: "Shy" },
    thoughtful: { emotion: "think", motion: "Think" },
  };
  return { ...mapping[state.emotion], intensity: Number(state.intensity.toFixed(3)) };
}

export class AffectEngine {
  private readonly store: ProductStore;

  constructor(store: ProductStore) {
    this.store = store;
  }

  current(ownerId: string, now = Date.now()): AffectiveState {
    return decayAffectiveState(this.store.loadAffectiveState(ownerId) ?? initialAffectiveState(now), now);
  }

  observeUserMessage(ownerId: string, sourceMessageId: string, text: string, now = Date.now()): AffectiveState {
    const before = this.current(ownerId, now);
    const event = appraiseUserMessage(text);
    const after = evolveAffectiveState(before, event, now);
    const inserted = this.store.applyAffectEvent({ ownerId, sourceMessageId, event, before, after, now });
    return inserted ? after : this.current(ownerId, now);
  }

  promptContext(ownerId: string, now = Date.now()): string {
    return affectPromptContext(this.current(ownerId, now));
  }

  expression(ownerId: string, now = Date.now()): AffectExpression {
    return affectExpression(this.current(ownerId, now));
  }
}

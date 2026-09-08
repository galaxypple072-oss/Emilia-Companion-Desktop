export type AgentRole = "user" | "assistant";

export interface AgentMessage {
  role: AgentRole;
  content: string;
}

export interface AgentRequest {
  systemPrompt: string;
  messages: AgentMessage[];
  finalInstruction?: string;
  conversation?: {
    intent: "casual" | "vent" | "emotional" | "question" | "task" | "detailed";
    move: "react" | "acknowledge" | "opinion" | "share" | "tease" | "act" | "ask" | "quiet";
    questionBudget: 0 | 1;
    maxChars: number;
  };
  grounding?: {
    verifiedMemories: string[];
  };
  signal?: AbortSignal;
}

export interface AgentAdapter {
  generateReply(request: AgentRequest): Promise<string>;
}

export interface AgentConfig {
  mode: "direct" | "harness";
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  contextMessages: number;
  thinking?: "enabled" | "disabled";
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected a number between ${min} and ${max}, received ${value}`);
  }
  return parsed;
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig | null {
  const apiKey = env.AGENT_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = env.AGENT_BASE_URL?.trim();
  const model = env.AGENT_MODEL?.trim();
  if (!baseUrl || !model) {
    throw new Error("AGENT_BASE_URL and AGENT_MODEL are required when AGENT_API_KEY is set");
  }
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("AGENT_BASE_URL must use HTTPS unless it points to localhost");
  }
  const thinking = env.AGENT_THINKING?.trim();
  if (thinking && thinking !== "enabled" && thinking !== "disabled") {
    throw new Error("AGENT_THINKING must be enabled or disabled");
  }
  const mode = env.AGENT_MODE?.trim().toLowerCase() || "direct";
  if (mode !== "direct" && mode !== "harness") throw new Error("AGENT_MODE must be direct or harness");
  return {
    mode,
    baseUrl: url.toString().replace(/\/$/u, ""),
    apiKey,
    model,
    maxTokens: Math.trunc(boundedNumber(env.AGENT_MAX_TOKENS, 800, 64, 8000)),
    temperature: boundedNumber(env.AGENT_TEMPERATURE, 0.8, 0, 2),
    timeoutMs: Math.trunc(boundedNumber(env.AGENT_TIMEOUT_MS, 60_000, 1000, 300_000)),
    contextMessages: Math.trunc(boundedNumber(env.AGENT_CONTEXT_MESSAGES, 20, 2, 100)),
    thinking: thinking as AgentConfig["thinking"],
  };
}

export class OpenAICompatibleAgent implements AgentAdapter {
  private readonly config: AgentConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: AgentConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async generateReply(request: AgentRequest): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: "system", content: request.systemPrompt },
        ...request.messages,
        ...(request.finalInstruction ? [{ role: "system", content: request.finalInstruction }] : []),
      ],
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: false,
    };
    if (this.config.thinking) body.thinking = { type: this.config.thinking };

    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    const raw = await response.text();
    let payload: ChatCompletionResponse;
    try {
      payload = JSON.parse(raw) as ChatCompletionResponse;
    } catch {
      throw new Error(`Agent returned non-JSON data (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`Agent request failed (HTTP ${response.status}): ${payload.error?.message ?? "unknown error"}`);
    }
    const reply = payload.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error("Agent returned an empty reply");
    return reply.slice(0, 4000);
  }
}

export interface OneBotConfig {
  httpUrl: string;
  wsUrl: string;
  accessToken: string;
  allowedQQs: ReadonlySet<string>;
  requestTimeoutMs: number;
}

const QQ_ID_PATTERN = /^\d{5,12}$/u;

function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseUrl(value: string, name: string, protocols: string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} must use ${protocols.join(" or ")}`);
  }

  return url.toString().replace(/\/$/u, "");
}

export function parseQQId(value: string): string {
  const normalized = value.trim();
  if (!QQ_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid QQ account ID: ${value}`);
  }
  return normalized;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OneBotConfig {
  const accessToken = requireValue(env, "ONEBOT_ACCESS_TOKEN");
  if (accessToken.length < 16) {
    throw new Error("ONEBOT_ACCESS_TOKEN must contain at least 16 characters");
  }

  const allowedQQs = new Set(
    requireValue(env, "ONEBOT_ALLOWED_QQ")
      .split(",")
      .map(parseQQId),
  );

  const requestTimeoutMs = Number(env.ONEBOT_REQUEST_TIMEOUT_MS ?? "10000");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 60000) {
    throw new Error("ONEBOT_REQUEST_TIMEOUT_MS must be an integer between 1000 and 60000");
  }

  return {
    httpUrl: parseUrl(
      env.ONEBOT_HTTP_URL?.trim() || "http://127.0.0.1:3000",
      "ONEBOT_HTTP_URL",
      ["http:", "https:"],
    ),
    wsUrl: parseUrl(
      env.ONEBOT_WS_URL?.trim() || "ws://127.0.0.1:3001",
      "ONEBOT_WS_URL",
      ["ws:", "wss:"],
    ),
    accessToken,
    allowedQQs,
    requestTimeoutMs,
  };
}

export function assertAllowedQQ(config: OneBotConfig, qq: string): string {
  const normalized = parseQQId(qq);
  if (!config.allowedQQs.has(normalized)) {
    throw new Error(`QQ account ${normalized} is not present in ONEBOT_ALLOWED_QQ`);
  }
  return normalized;
}

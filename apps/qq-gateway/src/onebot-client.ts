import { assertAllowedQQ, type OneBotConfig } from "./config.ts";

interface OneBotResponse<T> {
  status?: string;
  retcode?: number;
  message?: string;
  wording?: string;
  data?: T;
}

export class OneBotApiError extends Error {
  readonly action: string;
  readonly retcode?: number;

  constructor(
    message: string,
    action: string,
    retcode?: number,
  ) {
    super(message);
    this.name = "OneBotApiError";
    this.action = action;
    this.retcode = retcode;
  }
}

export class OneBotClient {
  private readonly config: OneBotConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: OneBotConfig,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async getStatus(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("get_status", {});
  }

  async getLoginInfo(): Promise<{ user_id?: number | string; nickname?: string }> {
    return this.call("get_login_info", {});
  }

  async getImage(file: string): Promise<{ file?: string; url?: string; file_size?: number; file_name?: string }> {
    const normalized = file.trim();
    if (!normalized || normalized.length > 2000) throw new Error("Invalid OneBot image file identifier");
    return this.call("get_image", { file: normalized }, 60_000);
  }

  async sendPrivateMessage(qq: string, message: string): Promise<Record<string, unknown>> {
    const userId = assertAllowedQQ(this.config, qq);
    const text = message.trim();
    if (!text) {
      throw new Error("Message must not be empty");
    }
    if (text.length > 4000) {
      throw new Error("Probe messages are limited to 4000 characters");
    }

    return this.call<Record<string, unknown>>("send_private_msg", {
      user_id: Number(userId),
      message: text,
      auto_escape: true,
    });
  }

  async sendPrivateImage(qq: string, file: string, options: { summary?: string; subType?: number } = {}): Promise<Record<string, unknown>> {
    const userId = assertAllowedQQ(this.config, qq);
    const normalized = file.trim();
    if (!normalized || normalized.length > 2000) throw new Error("Image path is invalid");
    return this.call<Record<string, unknown>>("send_private_msg", {
      user_id: Number(userId),
      message: [{ type: "image", data: {
        file: normalized,
        ...(options.summary ? { summary: options.summary } : {}),
        ...(Number.isInteger(options.subType) ? { sub_type: options.subType } : {}),
      } }],
    });
  }

  async sendPrivateFile(qq: string, file: string, name: string): Promise<Record<string, unknown>> {
    const userId = assertAllowedQQ(this.config, qq);
    const normalizedFile = file.trim();
    const normalizedName = name.trim();
    if (!normalizedFile || normalizedFile.length > 2000) throw new Error("File path is invalid");
    if (!normalizedName || normalizedName.length > 255 || /[\\/:*?"<>|\r\n]/u.test(normalizedName)) throw new Error("File display name is invalid");
    return this.call<Record<string, unknown>>("upload_private_file", {
      user_id: Number(userId),
      file: normalizedFile,
      name: normalizedName,
    }, 120_000);
  }

  private async call<T>(action: string, params: Record<string, unknown>, timeoutMs = this.config.requestTimeoutMs): Promise<T> {
    const response = await this.fetchImpl(`${this.config.httpUrl}/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const rawText = await response.text();
    let payload: OneBotResponse<T>;
    try {
      payload = JSON.parse(rawText) as OneBotResponse<T>;
    } catch {
      throw new OneBotApiError(
        `OneBot ${action} returned a non-JSON response (HTTP ${response.status})`,
        action,
      );
    }

    if (!response.ok || payload.status !== "ok" || payload.retcode !== 0) {
      const detail = payload.wording || payload.message || `HTTP ${response.status}`;
      throw new OneBotApiError(`OneBot ${action} failed: ${detail}`, action, payload.retcode);
    }

    return (payload.data ?? {}) as T;
  }
}

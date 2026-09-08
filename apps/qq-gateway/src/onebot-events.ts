import { assertAllowedQQ, type OneBotConfig } from "./config.ts";
import { OneBotClient } from "./onebot-client.ts";

interface OneBotPrivateMessageEvent {
  post_type: "message";
  message_type: "private";
  user_id: number | string;
  message_id?: number | string;
  raw_message?: string;
  time?: number;
}

function isPrivateMessageEvent(value: unknown): value is OneBotPrivateMessageEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const event = value as Record<string, unknown>;
  return event.post_type === "message" && event.message_type === "private";
}

export interface ListenOptions {
  echo: boolean;
  once: boolean;
}

export async function listenForPrivateMessages(
  config: OneBotConfig,
  client: OneBotClient,
  options: ListenOptions,
): Promise<void> {
  const url = new URL(config.wsUrl);
  url.searchParams.set("access_token", config.accessToken);

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    let finished = false;

    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      if (error) reject(error);
      else resolve();
    };

    socket.addEventListener("open", () => {
      console.log(`[qq-gateway] Listening on ${config.wsUrl} (token hidden)`);
    });

    socket.addEventListener("error", () => {
      finish(new Error(`Unable to connect to OneBot WebSocket at ${config.wsUrl}`));
    });

    socket.addEventListener("message", async (messageEvent) => {
      try {
        const event = JSON.parse(String(messageEvent.data)) as unknown;
        if (!isPrivateMessageEvent(event)) return;

        const qq = assertAllowedQQ(config, String(event.user_id));
        const text = event.raw_message ?? "";
        console.log(
          JSON.stringify(
            {
              event: "channel.message.received",
              channel: "qq_onebot",
              sender_id: qq,
              message_id: event.message_id,
              text,
              received_at: event.time ? new Date(event.time * 1000).toISOString() : undefined,
            },
            null,
            2,
          ),
        );

        if (options.echo) {
          await client.sendPrivateMessage(qq, `收到：${text || "（非文本消息）"}`);
        }
        if (options.once) finish();
      } catch (error) {
        if (error instanceof Error && error.message.includes("is not present in ONEBOT_ALLOWED_QQ")) {
          console.warn(`[qq-gateway] Ignored private message from a non-allowlisted account`);
          return;
        }
        console.error(`[qq-gateway] Failed to process event:`, error);
      }
    });

    process.once("SIGINT", () => finish());
    process.once("SIGTERM", () => finish());
  });
}

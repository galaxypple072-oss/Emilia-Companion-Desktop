import { parseEmailInstruction } from "./email.ts";
import type { ProductStore } from "./store.ts";

export interface EmailCommandResult {
  handled: boolean;
  reply?: string;
}

export function handleEmailInstruction(
  text: string,
  store: ProductStore,
  dedupeKey: string,
  emailConfigured: boolean,
): EmailCommandResult {
  let message;
  try {
    message = parseEmailInstruction(text);
  } catch (error) {
    return { handled: true, reply: error instanceof Error ? error.message : String(error) };
  }
  if (!message) return { handled: false };
  if (!emailConfigured) {
    return { handled: true, reply: "邮件功能还没有配置好。请先在电脑上设置发件邮箱和老板邮箱。" };
  }
  let recipient;
  try {
    recipient = store.resolveEmailRecipient(message.recipient);
  } catch (error) {
    return { handled: true, reply: error instanceof Error ? error.message : String(error) };
  }
  const action = store.createAction({
    kind: "send_email",
    summary: `给 ${recipient.label} <${recipient.email}> 发送邮件：${message.subject}`,
    payload: { to: recipient.email, recipientLabel: recipient.label, subject: message.subject, body: message.body },
    dedupeKey,
  });
  const token = action.id.slice(0, 8);
  return {
    handled: true,
    reply: action.created
      ? `邮件草稿已创建，尚未发送。\n收件人：${recipient.label} <${recipient.email}>\n主题：${message.subject}\n行动编号：${token}\n确认发送：/confirm ${token}\n取消：/cancel ${token}`
      : `这条邮件草稿已经存在。行动编号：${token}\n发送 /actions 查看状态。`,
  };
}

export const COMPANION_TIME_ZONE = "Asia/Hong_Kong";

function localParts(now: number, timeZone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function dayPeriod(hour: number): string {
  if (hour >= 5 && hour < 8) return "清晨";
  if (hour >= 8 && hour < 12) return "上午";
  if (hour >= 12 && hour < 14) return "中午";
  if (hour >= 14 && hour < 18) return "下午";
  if (hour >= 18 && hour < 23) return "晚上";
  return "深夜";
}

export function conversationGapText(now: number, lastAssistantAt: number | null): string {
  if (lastAssistantAt === null || !Number.isFinite(lastAssistantAt) || lastAssistantAt > now) return "没有可用的上一轮发送时间";
  const elapsed = now - lastAssistantAt;
  if (elapsed < 2 * 60_000) return "不到 2 分钟";
  if (elapsed < 60 * 60_000) return `约 ${Math.floor(elapsed / 60_000)} 分钟`;
  if (elapsed < 24 * 60 * 60_000) return `约 ${Math.floor(elapsed / 3_600_000)} 小时`;
  return `约 ${Math.floor(elapsed / 86_400_000)} 天`;
}

export function companionTimeContext(
  now = Date.now(),
  lastAssistantAt: number | null = null,
  timeZone = COMPANION_TIME_ZONE,
): string {
  const parts = localParts(now, timeZone);
  const hour = Number(parts.hour);
  return [
    "【当前时间背景｜不得照读】",
    `用户本地时间：${parts.year}年${parts.month}月${parts.day}日 ${parts.weekday} ${parts.hour}:${parts.minute}（${timeZone}，${dayPeriod(hour)}）。`,
    `距离你上一次实际发出消息：${conversationGapText(now, lastAssistantAt)}。`,
    "时间可以帮助理解‘今天、明天、刚才、很久没聊’以及调整轻微语气，但不要主动报时。",
    "不能只凭时段断定用户正在睡觉、吃饭、上课、工作或应该去休息；用户没有告别时，不要擅自说早安、晚安或结束对话。",
  ].join("\n");
}

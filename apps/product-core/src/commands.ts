import { parseDelay } from "./config.ts";
import type { ProductStore } from "./store.ts";
import { normalizeWeatherLocation } from "./weather.ts";

export interface CommandResult {
  handled: boolean;
  reply?: string;
}

const CHINESE_DIGITS: Record<string, number> = {
  "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
};

function parseClockNumber(value: string): number | null {
  if (/^\d+$/u.test(value)) return Number(value);
  if (value === "十") return 10;
  const ten = value.indexOf("十");
  if (ten >= 0) {
    const left = ten === 0 ? 1 : CHINESE_DIGITS[value.slice(0, ten)];
    const tail = value.slice(ten + 1);
    const right = tail ? CHINESE_DIGITS[tail] : 0;
    return left === undefined || right === undefined ? null : left * 10 + right;
  }
  return CHINESE_DIGITS[value] ?? null;
}

function parseNaturalReminderDueAt(when: string, now: number): number | null {
  const text = when.replace(/\s+/gu, "");
  const relative = /^([\d零〇一二两三四五六七八九十]+)(分钟|分|小时|钟头|天)后$/u.exec(text);
  if (relative) {
    const amount = parseClockNumber(relative[1]);
    if (!amount || amount < 1) return null;
    const multiplier = relative[2] === "天" ? 86_400_000 : (relative[2] === "小时" || relative[2] === "钟头" ? 3_600_000 : 60_000);
    return now + amount * multiplier;
  }
  const absolute = /^(今天|今晚|明天|后天)(上午|中午|下午|晚上)?([\d零〇一二两三四五六七八九十]+)(?:点|时)(?:([\d零〇一二两三四五六七八九十]+)分?)?$/u.exec(text);
  if (!absolute) return null;
  let hour = parseClockNumber(absolute[3]);
  const minute = absolute[4] ? parseClockNumber(absolute[4]) : 0;
  if (hour === null || minute === null || minute > 59) return null;
  const period = absolute[2] || "";
  if ((period === "下午" || period === "晚上") && hour < 12) hour += 12;
  if (period === "中午" && hour < 11) hour += 12;
  if (hour > 23) return null;
  const due = new Date(now);
  if (absolute[1] === "明天") due.setDate(due.getDate() + 1);
  if (absolute[1] === "后天") due.setDate(due.getDate() + 2);
  due.setHours(hour, minute, 0, 0);
  if ((absolute[1] === "今天" || absolute[1] === "今晚") && due.getTime() <= now) return null;
  return due.getTime();
}

function parseNaturalTask(text: string, now: number): { title: string; dueAt: number } | null {
  const clock = "[\\d零〇一二两三四五六七八九十]+(?:点|时)(?:[\\d零〇一二两三四五六七八九十]+分?)?";
  const when = `(?:(?:[\\d零〇一二两三四五六七八九十]+)(?:分钟|分|小时|钟头|天)后|(?:今天|今晚|明天|后天)(?:上午|中午|下午|晚上)?${clock})`;
  const patterns = [
    new RegExp(`^(?:请|帮我|麻烦你)?\\s*(?<when>${when})\\s*(?:提醒(?:我)?|别忘了提醒(?:我)?|到时候提醒(?:我)?)(?:一下)?\\s*(?<title>.+)$`, "u"),
    new RegExp(`^(?:请|帮我|麻烦你)?\\s*(?:提醒(?:我)?|别忘了提醒(?:我)?)(?:一下)?\\s*(?<when>${when})\\s*(?<title>.+)$`, "u"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text.trim());
    if (!match?.groups) continue;
    const dueAt = parseNaturalReminderDueAt(match.groups.when, now);
    const title = match.groups.title.replace(/^(?:我)?(?:要|去|得)?/u, "").trim().replace(/[。！!]+$/u, "");
    if (dueAt && title) return { title, dueAt };
  }
  return null;
}

export function handleCoreCommand(
  text: string,
  store: ProductStore,
  ownerQQ: string,
  now = Date.now(),
  sourceKey?: string,
): CommandResult {
  const normalized = text.trim();
  const conversationalLocation = /^(?:我)?(?:现在|目前|以后)?(?:常驻|常住)(?:城市|地点)?(?:是|在)?\s*(.+?)\s*[。！!]?$/u.exec(normalized)
    ?? /^(?:把|将)?(?:天气|常驻)(?:城市|地点)?(?:设置|设|改)(?:为|成)\s*(.+?)\s*[。！!]?$/u.exec(normalized)
    ?? /^(?:以后)?天气(?:按|以)\s*(.+?)(?:看|为准)?\s*[。！!]?$/u.exec(normalized);
  if (conversationalLocation) {
    try {
      const location = normalizeWeatherLocation(conversationalLocation[1]);
      store.setState("weather_location", location, now);
      store.setState("weather_force_requested_at", String(now), now);
      return { handled: true, reply: `记住了，常驻城市按“${location}”处理。我只会在出现值得提醒的异常天气时主动联系你。` };
    } catch (error) {
      return { handled: true, reply: `这个地点没能保存：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!normalized.startsWith("/")) {
    const task = parseNaturalTask(normalized, now);
    if (!task) return { handled: false };
    try {
      const created = store.createTask({ ...task, sourceKey, now });
      const due = new Date(created.task.dueAt!).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      return { handled: true, reply: created.created ? `好，${due} 提醒你“${created.task.title}”` : `这条提醒已经记着了：${created.task.title}` };
    } catch (error) {
      return { handled: true, reply: `这条提醒没能记下：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (normalized === "/help") {
    return {
      handled: true,
      reply: [
        "可用命令：",
        "/status — 查看核心状态",
        "/quiet on|off — 切换主动消息安静模式",
        "/interest add 主题 — 添加内容兴趣",
        "/interests — 查看兴趣订阅",
        "/interest remove 编号 — 删除兴趣订阅",
        "/discover on|off|status|now — 控制联网内容发现",
        "/location 城市|status|clear — 设置天气常驻城市",
        "/weather on|off|status|now — 控制异常天气提醒",
        "/tasks — 查看待办任务",
        "/todo 2h 任务内容 — 创建有截止时间的任务",
        "/done 编号 — 完成任务",
        "/snooze 编号 2h — 推迟任务",
        "/task cancel 编号 — 取消任务",
        "/remind 10m 提醒内容 — 创建提醒",
        "/email 收件人 | 主题 | 正文 — 创建邮件草稿",
        "/contacts — 查看联系人",
        "/contact add 别名 邮箱 — 添加联系人",
        "/contact remove 别名 — 删除联系人",
        "/actions — 查看近期行动",
        "/devices — 查看在线客户端与已授权能力",
        "/device info 设备 — 读取设备基本信息",
        "/device open 设备 https://… — 在设备打开网页",
        "/device copy 设备 文字 — 写入设备剪贴板",
        "/device notify 设备 内容 — 在设备显示通知",
        "/remember 内容 — 明确保存一条长期记忆",
        "/memory — 查看长期记忆",
        "/forget 记忆编号 — 删除一条长期记忆",
        "/confirm 行动编号 — 确认执行",
        "/cancel 行动编号 — 取消行动",
        "/help — 查看帮助",
      ].join("\n"),
    };
  }
  if (normalized === "/status") {
    const summary = store.summary(now);
    return {
      handled: true,
      reply: `Product Core 正常。队列：${JSON.stringify(summary.outbox)}；已记录私聊：${summary.inbound} 条；安静模式：${store.getState("quiet_mode") === "on" ? "开启" : "关闭"}。`,
    };
  }
  if (normalized === "/actions") {
    const labels: Record<string, string> = {
      pending_confirmation: "待确认",
      approved: "等待执行",
      running: "执行中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
    };
    const actions = store.listActions(8);
    return {
      handled: true,
      reply: actions.length === 0
        ? "目前没有行动记录。"
        : ["近期行动：", ...actions.map((action) => `${action.id.slice(0, 8)} [${labels[action.status] ?? action.status}] ${action.summary}`)].join("\n"),
    };
  }
  if (normalized === "/tasks") {
    const tasks = store.listTasks("pending", 20);
    return {
      handled: true,
      reply: tasks.length === 0 ? "目前没有待办任务。" : [
        "待办任务：",
        ...tasks.map((task) => {
          const due = task.dueAt === null ? "无截止时间" : new Date(task.dueAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
          return `${task.id.slice(0, 8)} ${task.title}（${due}）`;
        }),
      ].join("\n"),
    };
  }
  const todo = /^\/todo\s+(\S+)\s+(.+)$/su.exec(normalized);
  if (todo) {
    try {
      const dueAt = now + parseDelay(todo[1]);
      const result = store.createTask({ title: todo[2], dueAt, sourceKey, now });
      return { handled: true, reply: `任务已记下：${result.task.title}\n编号：${result.task.id.slice(0, 8)}` };
    } catch (error) {
      return { handled: true, reply: `任务没能创建：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const done = /^\/done\s+([0-9a-f-]+)$/iu.exec(normalized);
  if (done) {
    try {
      const task = store.completeTask(done[1], now);
      return { handled: true, reply: `完成啦：${task.title}` };
    } catch (error) {
      return { handled: true, reply: `没能完成任务：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const snooze = /^\/snooze\s+([0-9a-f-]+)\s+(\S+)$/iu.exec(normalized);
  if (snooze) {
    try {
      const dueAt = now + parseDelay(snooze[2]);
      const task = store.snoozeTask(snooze[1], dueAt, now);
      return { handled: true, reply: `已推迟“${task.title}”到 ${new Date(dueAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}。` };
    } catch (error) {
      return { handled: true, reply: `没能推迟：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const cancelTask = /^\/task\s+cancel\s+([0-9a-f-]+)$/iu.exec(normalized);
  if (cancelTask) {
    try {
      const task = store.cancelTask(cancelTask[1], now);
      return { handled: true, reply: `已取消任务：${task.title}` };
    } catch (error) {
      return { handled: true, reply: `没能取消：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (normalized === "/contacts") {
    const contacts = store.listContacts();
    return {
      handled: true,
      reply: contacts.length === 0
        ? "联系人簿为空。使用 /contact add 别名 邮箱 添加。"
        : ["联系人：", ...contacts.map((contact) => `${contact.alias} — ${contact.email}`)].join("\n"),
    };
  }
  if (normalized === "/memory") {
    const memories = store.listMemories(20);
    return {
      handled: true,
      reply: memories.length === 0
        ? "现在还没有长期记忆。你可以用 /remember 内容 让我明确记住一件事。"
        : ["我目前记得：", ...memories.map((memory) => `${memory.id.slice(0, 8)} ${memory.content}`)].join("\n"),
    };
  }
  const remember = /^\/remember\s+(.+)$/su.exec(normalized);
  if (remember) {
    try {
      const memory = store.rememberExplicit(remember[1], null, now);
      return { handled: true, reply: `好，我记住了：${memory.content}\n记忆编号：${memory.id.slice(0, 8)}` };
    } catch (error) {
      return { handled: true, reply: `这条记忆没能保存：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const forget = /^\/forget\s+([0-9a-f-]+)$/iu.exec(normalized);
  if (forget) {
    try {
      const memory = store.forgetMemory(forget[1], now);
      return { handled: true, reply: `已经忘掉了：${memory.content}` };
    } catch (error) {
      return { handled: true, reply: `没能删除：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const addContact = /^\/contact\s+add\s+(.+?)\s+(\S+@\S+)$/iu.exec(normalized);
  if (addContact) {
    try {
      store.upsertContact(addContact[1], addContact[2], now);
      return { handled: true, reply: `联系人已保存：${addContact[1]} — ${addContact[2].toLowerCase()}` };
    } catch (error) {
      return { handled: true, reply: `联系人保存失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const removeContact = /^\/contact\s+remove\s+(.+)$/iu.exec(normalized);
  if (removeContact) {
    return {
      handled: true,
      reply: store.removeContact(removeContact[1]) ? `联系人“${removeContact[1]}”已删除。` : `找不到联系人“${removeContact[1]}”。`,
    };
  }
  const confirm = /^\/confirm\s+([0-9a-f-]+)$/iu.exec(normalized);
  if (confirm) {
    try {
      const action = store.confirmAction(confirm[1], now);
      return { handled: true, reply: `已确认行动 ${action.id.slice(0, 8)}：${action.summary}\n正在等待执行。` };
    } catch (error) {
      return { handled: true, reply: `无法确认：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const cancel = /^\/cancel\s+([0-9a-f-]+)$/iu.exec(normalized);
  if (cancel) {
    try {
      const action = store.cancelAction(cancel[1], now);
      return { handled: true, reply: `已取消行动 ${action.id.slice(0, 8)}：${action.summary}` };
    } catch (error) {
      return { handled: true, reply: `无法取消：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const quiet = /^\/quiet\s+(on|off)$/iu.exec(normalized);
  if (quiet) {
    store.setState("quiet_mode", quiet[1].toLowerCase(), now);
    return {
      handled: true,
      reply: quiet[1].toLowerCase() === "on"
        ? "安静模式已开启。我仍会回复你，但会暂停非必要的主动消息。"
        : "安静模式已关闭。之后可以按计划进行主动提醒和关怀。",
    };
  }
  if (normalized === "/interests") {
    const interests = store.listInterests();
    return { handled: true, reply: interests.length
      ? ["当前兴趣：", ...interests.map((interest) => `${interest.id.slice(0, 8)} ${interest.topic}`)].join("\n")
      : "还没有兴趣订阅。可以发送 /interest add 主题。" };
  }
  const locationCommand = /^\/location(?:\s+(.+))?$/iu.exec(normalized);
  if (locationCommand) {
    const value = locationCommand[1]?.trim();
    if (!value || value.toLowerCase() === "status") {
      const location = store.getState("weather_location");
      return { handled: true, reply: location ? `当前天气常驻城市：${location}。` : "还没有设置常驻城市。直接说“我常驻上海”即可。" };
    }
    if (value.toLowerCase() === "clear") {
      store.deleteState("weather_location");
      return { handled: true, reply: "已清除天气常驻城市，之后不会自动检查天气。" };
    }
    try {
      const location = normalizeWeatherLocation(value.replace(/^set\s+/iu, ""));
      store.setState("weather_location", location, now);
      store.setState("weather_force_requested_at", String(now), now);
      return { handled: true, reply: `天气常驻城市已设为“${location}”。只在异常天气值得提醒时联系你。` };
    } catch (error) {
      return { handled: true, reply: `地点保存失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const weather = /^\/weather\s+(on|off|status|now)$/iu.exec(normalized);
  if (weather) {
    const operation = weather[1].toLowerCase();
    if (operation === "on" || operation === "off") {
      store.setState("weather_mode", operation, now);
      return { handled: true, reply: operation === "on" ? "异常天气提醒已开启。" : "异常天气提醒已关闭。" };
    }
    const location = store.getState("weather_location");
    if (operation === "now") {
      if (!location) return { handled: true, reply: "先告诉我常驻城市，例如“我常驻上海”。" };
      store.setState("weather_force_requested_at", String(now), now);
      return { handled: true, reply: `好，我马上检查${location}有没有值得提醒的异常天气。` };
    }
    return { handled: true, reply: `异常天气提醒：${store.getState("weather_mode") === "off" ? "关闭" : "开启"}；常驻城市：${location ?? "未设置"}。` };
  }
  const addInterest = /^\/interest\s+add\s+(.+)$/iu.exec(normalized);
  if (addInterest) {
    try {
      const interest = store.addInterest(addInterest[1], now);
      return { handled: true, reply: `已订阅“${interest.topic}”。只有发现有来源的新内容时才会主动分享。` };
    } catch (error) {
      return { handled: true, reply: `订阅失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const removeInterest = /^\/interest\s+remove\s+([0-9a-f-]+)$/iu.exec(normalized);
  if (removeInterest) {
    try {
      const interest = store.removeInterest(removeInterest[1], now);
      return { handled: true, reply: `已取消订阅“${interest.topic}”。` };
    } catch (error) {
      return { handled: true, reply: `取消失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const discover = /^\/(?:discover|proactive)\s+(on|off|status|now)$/iu.exec(normalized);
  if (discover) {
    const operation = discover[1].toLowerCase();
    if (operation === "on" || operation === "off") {
      store.setState("discovery_mode", operation, now);
      return { handled: true, reply: operation === "on" ? "联网内容发现已开启。只有找到有来源的新内容才会联系你。" : "联网内容发现已关闭，提醒和普通回复不受影响。" };
    }
    if (operation === "now") {
      if (store.listInterests(1).length === 0) return { handled: true, reply: "先添加一个兴趣吧，例如：/interest add DeepSeek 和 AI Agent" };
      store.setState("discovery_force_requested_at", String(now), now);
      return { handled: true, reply: "好，我马上按你的兴趣实际搜索一次。有值得分享的结果才会再发给你。" };
    }
    const mode = store.getState("discovery_mode") ?? "default";
    return {
      handled: true,
      reply: `联网内容发现：${mode === "off" ? "关闭" : mode === "on" ? "开启" : "跟随系统设置"}；兴趣 ${store.listInterests().length} 个；安静模式：${store.getState("quiet_mode") === "on" ? "开启" : "关闭"}。`,
    };
  }
  const reminder = /^\/remind\s+(\S+)\s+(.+)$/su.exec(normalized);
  if (reminder) {
    try {
      const dueAt = now + parseDelay(reminder[1]);
      store.enqueue({ recipientId: ownerQQ, body: reminder[2], dueAt });
      return {
        handled: true,
        reply: `好的，提醒已记录：${new Date(dueAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}。`,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { handled: true, reply: `提醒格式不对：${detail}` };
    }
  }
  return { handled: true, reply: "我还不认识这个命令。发送 /help 可以查看当前支持的命令。" };
}

import { copyFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProductStore, Sticker } from "./store.ts";

const TEACH_STICKER = /(?:(?:记住|收下|保存|存下|学会).{0,12}(?:表情包|这个表情|这张图)|(?:以后|下次).{0,8}(?:可以|就).{0,6}(?:用|发).{0,8}(?:这个|它)|(?:这个|这是).{0,8}(?:表情包|表情)|教你.{0,8}(?:用|发)?表情包)/u;
const SEND_STICKER = /(?:(?:发|来)(?:一下|一个|个|张)?(?:刚才|刚刚|刚保存|这个|那个|无语|开心|生气|难过|可爱)?(?:的)?(?:表情包|表情)|把.{0,12}(?:表情包|表情).{0,8}发)/u;
const DIRECTIVE = /\[\[sticker:([0-9a-f-]{36})\]\]/giu;
const OUTBOX = /^\[\[internal-sticker:([0-9a-f-]{36})\]\]$/iu;

export function isStickerTeachingCaption(caption: string): boolean {
  return TEACH_STICKER.test(caption.trim());
}

export function isStickerSendRequest(text: string): boolean {
  return SEND_STICKER.test(text.trim());
}

export function extractStickerDirective(text: string): { text: string; stickerId: string | null } {
  let stickerId: string | null = null;
  const cleaned = text.replace(DIRECTIVE, (_match, id: string) => {
    stickerId ??= id.toLowerCase();
    return "";
  }).replace(/\n{3,}/gu, "\n\n").trim();
  return { text: cleaned, stickerId };
}

export function stickerOutboxBody(id: string): string {
  if (!/^[0-9a-f-]{36}$/iu.test(id)) throw new Error("Invalid sticker id");
  return `[[internal-sticker:${id.toLowerCase()}]]`;
}

export function parseStickerOutboxBody(body: string): string | null {
  return OUTBOX.exec(body.trim())?.[1]?.toLowerCase() ?? null;
}

function compact(value: string, limit: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, limit);
}

export class StickerLibrary {
  private readonly store: ProductStore;
  private readonly directory: string;

  constructor(store: ProductStore, directory: string) {
    this.store = store;
    this.directory = directory;
  }

  async learn(sourcePath: string, caption: string, analysis: string, formatSuffix?: string, nativePayload?: { summary?: string; subType?: number } | null): Promise<Sticker> {
    await mkdir(this.directory, { recursive: true });
    const suffix = (formatSuffix || extname(sourcePath)).toLowerCase();
    if (!/[.](?:png|jpe?g|gif|webp)$/u.test(suffix)) throw new Error("Unsupported sticker image format");
    const id = randomUUID();
    const destination = join(this.directory, `${id}${suffix}`);
    await copyFile(sourcePath, destination);
    return this.store.addSticker({
      id,
      path: destination,
      description: compact(caption || analysis, 240),
      tags: compact(`${caption} ${analysis}`, 600),
      nativePayload: nativePayload ?? null,
    });
  }

  promptContext(): string {
    const stickers = this.store.listStickers(30);
    if (stickers.length === 0) return "";
    const catalog = stickers.map((item) => `- ${item.id}: ${item.description || item.tags}`).join("\n");
    return [
      "【可用表情包】",
      catalog,
      "表情包是可选的非语言反应，不是每轮必发。只有它比文字更自然、更贴合当下情绪时，才在回复末尾另起一行写一次 [[sticker:ID]]。",
      "不得虚构 ID，不得解释这个标记，不得连续几轮发表情包；严肃任务、错误、隐私与确认流程中不要使用。可以只发文字。",
    ].join("\n");
  }

  resolveUsable(id: string | null, now = Date.now()): Sticker | null {
    if (!id || !this.store.canUseSticker(now)) return null;
    return this.store.getSticker(id);
  }
}

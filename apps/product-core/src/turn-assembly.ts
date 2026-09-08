import type { OneBotImageReference } from "../../qq-gateway/src/onebot-images.ts";

const CONTINUATION_PREFIX = /^(?:而且|然后|结果|主要是|还有|另外|不过|但是|可(?:是|问题是)|就是|因为|所以|甚至|接着|最后|对了)/u;
const OPEN_ENDING = /(?:[，,、：:]|\.{2,}|…{1,}|—{1,}|-)[\s]*$/u;
const EMOJI_COMPONENT = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u200d\ufe0e\ufe0f\p{Emoji_Modifier}\s]/gu;

export function replyQuietWindowMs(text: string): number {
  const normalized = text.trim();
  return CONTINUATION_PREFIX.test(normalized) || OPEN_ENDING.test(normalized) ? 5500 : 3500;
}

export function isOnlyEmojiMessage(text: string): boolean {
  const normalized = text.trim();
  if (!normalized || !/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(normalized)) return false;
  return normalized.replace(EMOJI_COMPONENT, "").length === 0;
}

export function isLikelyQqSticker(image: OneBotImageReference, caption: string): boolean {
  if (caption.trim()) return false;
  if (image.subType === 1) return true;
  return /(?:动画表情|表情包|QQ表情|贴纸|sticker)/iu.test(image.summary ?? "");
}

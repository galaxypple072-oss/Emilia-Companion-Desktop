const EXPLICIT_LONG_REQUEST = /(?:详细(?:讲|说|分析|解释)?|深入(?:分析|解释)?|展开(?:讲|说)?|完整(?:方案|分析|说明|教程)|逐步(?:分析|说明)?|一步一步|列(?:个|出).{0,8}(?:清单|步骤)|做.{0,8}(?:比较|对比)|系统性地|全面分析)/u;

export function isExplicitLongRequest(text: string): boolean {
  return EXPLICIT_LONG_REQUEST.test(text);
}

function splitSentences(text: string): string[] {
  return text.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu)?.map((part) => part.trim()).filter(Boolean) ?? [text];
}

function splitCasualClauses(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const clauses = text.match(/[^，,、…]+(?:[，,、]|…{1,2})?/gu)?.map((part) => part.trim()).filter(Boolean) ?? [text];
  return pack(clauses, maxChars);
}

function pack(parts: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const boundedParts = parts.flatMap((part) => part.length <= maxChars
    ? [part]
    : Array.from({ length: Math.ceil(part.length / maxChars) }, (_, index) => part.slice(index * maxChars, (index + 1) * maxChars)));
  for (const part of boundedParts) {
    if (!current) {
      current = part;
      continue;
    }
    if ((current + part).length <= maxChars) current += part;
    else {
      chunks.push(current);
      current = part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function casualPunctuation(chunks: string[]): string[] {
  return chunks.map((chunk) => chunk.replace(/。$/u, "").trim()).filter(Boolean);
}

export function formatQqReply(reply: string, userText: string): string[] {
  const normalized = reply.trim().replace(/\n{3,}/gu, "\n\n");
  if (!normalized) throw new Error("Reply must not be empty");
  const complex = isExplicitLongRequest(userText);
  const maxChunkChars = complex ? 700 : 38;
  const maxChunks = complex ? 6 : 4;
  const paragraphs = normalized.split(complex ? /\n{2,}/u : /\n+/u).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  for (const paragraph of paragraphs) {
    if (complex) {
      if (paragraph.length <= maxChunkChars) chunks.push(paragraph);
      else chunks.push(...pack(splitSentences(paragraph), maxChunkChars));
      continue;
    }
    for (const sentence of splitSentences(paragraph)) chunks.push(...splitCasualClauses(sentence, maxChunkChars));
  }
  if (chunks.length <= maxChunks) return complex ? chunks : casualPunctuation(chunks);
  if (complex) {
    const head = chunks.slice(0, maxChunks - 1);
    return [...head, chunks.slice(maxChunks - 1).join("\n\n").slice(0, 4000)];
  }
  const head = chunks.slice(0, maxChunks - 1);
  const tail = chunks.slice(maxChunks - 1).join("");
  const compactTail = tail.length <= 60 ? tail : `${tail.slice(0, 25)}…${tail.slice(-34)}`;
  return casualPunctuation([...head, compactTail]);
}

export function qqBubbleOffsets(count: number, random: () => number = Math.random): number[] {
  const offsets: number[] = [];
  let elapsed = 0;
  for (let index = 0; index < count; index += 1) {
    if (index > 0) elapsed += 550 + Math.floor(random() * 751);
    offsets.push(elapsed);
  }
  return offsets;
}

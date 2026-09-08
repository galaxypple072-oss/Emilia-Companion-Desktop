export interface OneBotImageReference {
  file: string;
  url?: string;
  summary?: string;
  subType?: number;
}

export interface OneBotFaceReference {
  id: string;
}

export interface ParsedOneBotMessage {
  text: string;
  image: OneBotImageReference | null;
  faces: OneBotFaceReference[];
}

function decodeCq(value: string): string {
  return value
    .replaceAll("&#44;", ",")
    .replaceAll("&#91;", "[")
    .replaceAll("&#93;", "]")
    .replaceAll("&amp;", "&");
}

export function parseOneBotMessage(message: unknown, rawMessage = ""): ParsedOneBotMessage {
  if (Array.isArray(message)) {
    const text: string[] = [];
    let image: OneBotImageReference | null = null;
    const faces: OneBotFaceReference[] = [];
    for (const segment of message) {
      if (!segment || typeof segment !== "object") continue;
      const record = segment as { type?: unknown; data?: unknown };
      const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
      if (record.type === "text" && typeof data.text === "string") text.push(data.text);
      if (record.type === "face" && (typeof data.id === "string" || typeof data.id === "number")) {
        faces.push({ id: String(data.id) });
      }
      if (!image && record.type === "image" && typeof data.file === "string" && data.file.trim()) {
        image = {
          file: data.file.trim(),
          ...(typeof data.url === "string" && data.url.trim() ? { url: data.url.trim() } : {}),
          ...(typeof data.summary === "string" && data.summary.trim() ? { summary: data.summary.trim() } : {}),
          ...(typeof data.sub_type === "number" && Number.isInteger(data.sub_type) ? { subType: data.sub_type } : {}),
        };
      }
    }
    return { text: text.join("").trim(), image, faces };
  }

  let image: OneBotImageReference | null = null;
  const faces: OneBotFaceReference[] = [];
  const withoutImages = rawMessage.replace(/\[CQ:image,([^\]]+)\]/gu, (_match, rawParams: string) => {
    const params = Object.fromEntries(rawParams.split(",").map((part) => {
      const split = part.indexOf("=");
      return split < 0 ? [part, ""] : [part.slice(0, split), decodeCq(part.slice(split + 1))];
    }));
    if (!image && params.file) image = {
      file: params.file,
      ...(params.url ? { url: params.url } : {}),
      ...(params.summary ? { summary: params.summary } : {}),
      ...(/^\d+$/u.test(params.sub_type ?? "") ? { subType: Number(params.sub_type) } : {}),
    };
    return " ";
  });
  const text = withoutImages.replace(/\[CQ:face,([^\]]+)\]/gu, (_match, rawParams: string) => {
    const params = Object.fromEntries(rawParams.split(",").map((part) => {
      const split = part.indexOf("=");
      return split < 0 ? [part, ""] : [part.slice(0, split), decodeCq(part.slice(split + 1))];
    }));
    if (params.id) faces.push({ id: params.id });
    return " ";
  }).trim();
  return { text, image, faces };
}

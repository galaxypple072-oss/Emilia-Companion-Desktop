import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import sharp from "sharp";
import { detectImageMediaType } from "./vision.ts";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const REDIRECT_LIMIT = 3;

export interface ResolvedWebImage {
  sourceUrl: string;
  imageUrl: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  size: number;
  width: number;
  height: number;
  bytes: Buffer;
}

type ResolveHost = (hostname: string) => Promise<string[]>;

function blockedIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function blockedIp(address: string): boolean {
  if (isIP(address) === 4) return blockedIpv4(address);
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized);
  return mapped ? blockedIpv4(mapped[1]) : false;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

async function safeUrl(input: string, resolveHost: ResolveHost): Promise<URL> {
  const url = new URL(input);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw new Error("Web image URL must be public HTTP(S) without credentials");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Web image URL uses a disallowed port");
  if (url.hostname === "localhost" || url.hostname.endsWith(".local")) throw new Error("Local network image URLs are not allowed");
  const addresses = isIP(url.hostname) ? [url.hostname] : await resolveHost(url.hostname);
  if (addresses.length === 0 || addresses.some(blockedIp)) throw new Error("Web image URL resolves to a private or unsafe address");
  return url;
}

async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Web image response exceeds the size limit");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Web image response exceeds the size limit");
    }
    chunks.push(Buffer.from(part.value));
  }
  return Buffer.concat(chunks, total);
}

async function fetchPublic(
  input: string,
  maxBytes: number,
  fetchImpl: typeof fetch,
  resolveHost: ResolveHost,
): Promise<{ url: URL; response: Response; bytes: Buffer }> {
  let url = await safeUrl(input, resolveHost);
  for (let redirects = 0; redirects <= REDIRECT_LIMIT; redirects += 1) {
    const response = await fetchImpl(url, {
      redirect: "manual",
      headers: { "user-agent": "PersonalCompanion/0.1 (+local owner requested image fetch)", accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,text/html;q=0.8" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === REDIRECT_LIMIT) throw new Error("Web image redirect could not be followed safely");
      url = await safeUrl(new URL(location, url).toString(), resolveHost);
      continue;
    }
    if (!response.ok) throw new Error(`Web image source returned HTTP ${response.status}`);
    return { url, response, bytes: await readBounded(response, maxBytes) };
  }
  throw new Error("Web image redirect limit exceeded");
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "iu").exec(tag);
  return match?.[1]?.replace(/&amp;/gu, "&") ?? null;
}

function likelyOriginal(input: string): string | null {
  const url = new URL(input);
  const originalPath = url.pathname.replace(/-\d{2,5}x\d{2,5}(?=\.(?:jpe?g|png|webp)$)/iu, "");
  if (originalPath === url.pathname) return null;
  url.pathname = originalPath;
  for (const key of ["resize", "fit", "w", "width", "h", "height"]) url.searchParams.delete(key);
  return url.toString();
}

function htmlImageUrls(html: string, base: URL): string[] {
  const urls: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    const key = (attribute(tag, "property") ?? attribute(tag, "name") ?? "").toLowerCase();
    if (!["og:image", "og:image:secure_url", "twitter:image", "twitter:image:src"].includes(key)) continue;
    const content = attribute(tag, "content");
    if (content) urls.push(new URL(content, base).toString());
  }
  for (const tag of html.match(/<link\b[^>]*>/giu) ?? []) {
    if (attribute(tag, "rel")?.toLowerCase() !== "image_src") continue;
    const href = attribute(tag, "href");
    if (href) urls.push(new URL(href, base).toString());
  }
  for (const tag of html.match(/<(?:img|source)\b[^>]*>/giu) ?? []) {
    const srcset = attribute(tag, "srcset");
    if (srcset) {
      const entries = srcset.split(",").map((entry) => entry.trim().split(/\s+/u)).filter((entry) => entry[0]);
      entries.sort((a, b) => Number.parseInt(b[1] ?? "0", 10) - Number.parseInt(a[1] ?? "0", 10));
      for (const entry of entries.slice(0, 3)) urls.push(new URL(entry[0], base).toString());
    }
    const src = attribute(tag, "src");
    if (src && /(?:wallpaper|original|full|upload|image)/iu.test(src)) urls.push(new URL(src, base).toString());
  }
  const expanded = urls.flatMap((url) => [likelyOriginal(url), url].filter((value): value is string => Boolean(value)));
  return [...new Set(expanded)].slice(0, 8);
}

async function inspected(bytes: Buffer): Promise<{ mediaType: ResolvedWebImage["mediaType"]; width: number; height: number }> {
  const mediaType = detectImageMediaType(bytes);
  if (!mediaType) throw new Error("Downloaded content is not a supported JPEG, PNG, WebP, or GIF image");
  const metadata = await sharp(bytes, { animated: false }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Downloaded image dimensions could not be read");
  return { mediaType, width: metadata.width, height: metadata.height };
}

export class WebImageService {
  private readonly fetchImpl: typeof fetch;
  private readonly resolveHost: ResolveHost;

  constructor(fetchImpl: typeof fetch = fetch, resolveHost: ResolveHost = defaultResolveHost) {
    this.fetchImpl = fetchImpl;
    this.resolveHost = resolveHost;
  }

  async resolve(source: string): Promise<ResolvedWebImage> {
    const normalized = source.trim();
    if (!normalized || normalized.length > 3000) throw new Error("Web image source URL is invalid");
    const initial = await fetchPublic(normalized, MAX_IMAGE_BYTES, this.fetchImpl, this.resolveHost);
    const initialType = initial.response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const candidates: Array<{ url: string; bytes?: Buffer }> = [];
    if (initialType === "text/html" || initialType === "application/xhtml+xml") {
      if (initial.bytes.length > MAX_HTML_BYTES) throw new Error("Web image page is too large to inspect");
      candidates.push(...htmlImageUrls(initial.bytes.toString("utf8"), initial.url).map((url) => ({ url })));
      if (candidates.length === 0) throw new Error("No shareable preview image was found on that page");
    } else {
      const original = likelyOriginal(initial.url.toString());
      if (original) candidates.push({ url: original });
      candidates.push({ url: initial.url.toString(), bytes: initial.bytes });
    }
    let best: ResolvedWebImage | null = null;
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        const resource = candidate.bytes ? { url: new URL(candidate.url), bytes: candidate.bytes }
          : await fetchPublic(candidate.url, MAX_IMAGE_BYTES, this.fetchImpl, this.resolveHost);
        const metadata = await inspected(resource.bytes);
        const resolved: ResolvedWebImage = {
          sourceUrl: initial.url.toString(), imageUrl: resource.url.toString(), size: resource.bytes.length,
          bytes: resource.bytes, ...metadata,
        };
        const score = resolved.width * resolved.height;
        const bestScore = best ? best.width * best.height : -1;
        if (!best || score > bestScore || (score === bestScore && resolved.size > best.size)) best = resolved;
      } catch (error) {
        lastError = error;
      }
    }
    if (!best) throw lastError instanceof Error ? lastError : new Error("No downloadable image candidate passed validation");
    return best;
  }
}

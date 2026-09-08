import { basename } from "node:path";

export interface GradioFile {
  path: string;
  url?: string;
  orig_name?: string;
}

interface CallStarted { event_id?: string; eventId?: string; }

function endpoint(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\//u, ""), `${baseUrl.replace(/\/$/u, "")}/`).toString();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gradio returned an invalid response");
  return value as Record<string, unknown>;
}

function fileFrom(value: unknown): GradioFile {
  // GPT-SoVITS' bundled Gradio 4.44 /upload endpoint returns a bare Windows
  // path, whereas newer Gradio returns FileData. Support both wire formats.
  if (typeof value === "string" && value) return { path: value };
  const record = asRecord(value);
  const path = typeof record.path === "string" ? record.path : "";
  const url = typeof record.url === "string" ? record.url : undefined;
  if (!path && !url) throw new Error("Gradio did not return an audio file");
  return { path, url, orig_name: typeof record.orig_name === "string" ? record.orig_name : undefined };
}

/** Small, dependency-free client for the Gradio 4 /call SSE protocol used by
 * the Windows GPT-SoVITS UI. */
export class GradioClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 180_000) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async uploadFile(path: string, bytes: Uint8Array, contentType = "audio/wav"): Promise<GradioFile> {
    const form = new FormData();
    form.append("files", new Blob([bytes], { type: contentType }), basename(path));
    const response = await this.fetch(endpoint(this.baseUrl, "upload"), { method: "POST", body: form });
    if (!response.ok) throw new Error(`Gradio upload failed (${response.status})`);
    const payload = await response.json() as unknown;
    const uploaded = Array.isArray(payload) ? payload[0] : payload;
    return fileFrom(uploaded);
  }

  async call(apiName: string, data: unknown[]): Promise<unknown[]> {
    const start = await this.fetch(endpoint(this.baseUrl, `call/${apiName}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    });
    if (!start.ok) throw new Error(`Gradio ${apiName} did not start (${start.status})`);
    const started = await start.json() as CallStarted;
    const eventId = started.event_id ?? started.eventId;
    if (!eventId) throw new Error(`Gradio ${apiName} did not return an event id`);
    return this.waitForResult(apiName, eventId);
  }

  private async waitForResult(apiName: string, eventId: string): Promise<unknown[]> {
    const response = await this.fetch(endpoint(this.baseUrl, `call/${apiName}/${encodeURIComponent(eventId)}`));
    if (!response.ok || !response.body) throw new Error(`Gradio ${apiName} stream failed (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/u);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const type = /^event:\s*(.+)$/mu.exec(block)?.[1]?.trim();
          const payload = /^data:\s*(.+)$/mu.exec(block)?.[1]?.trim();
          if (!payload) continue;
          let data: unknown;
          try { data = JSON.parse(payload); } catch { continue; }
          if (type === "error") throw new Error(typeof data === "string" ? data : JSON.stringify(data));
          if (type === "complete") {
            if (!Array.isArray(data)) throw new Error(`Gradio ${apiName} returned malformed data`);
            return data;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    throw new Error(`Gradio ${apiName} closed before completing`);
  }

  private async fetch(input: string, init?: RequestInit): Promise<Response> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    return fetch(input, { ...init, signal });
  }
}

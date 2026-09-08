import { readdir, readFile, realpath, rename, stat, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep, dirname, basename, extname } from "node:path";
import mammoth from "mammoth";
import ExcelJS from "exceljs";

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".jsonl", ".csv", ".tsv", ".xml", ".yaml", ".yml",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".html", ".htm",
  ".py", ".java", ".c", ".h", ".cpp", ".hpp", ".rs", ".go", ".sql", ".log", ".ini", ".toml",
]);

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt?: string;
}

export interface ParsedDocument {
  path: string;
  format: "pdf" | "docx" | "xlsx";
  text: string;
  truncated: boolean;
  details: Record<string, unknown>;
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function loadPdfParser(): Promise<typeof import("pdf-parse").PDFParse> {
  // pdfjs tries to load a native canvas package on Node even when we only need
  // text extraction. Some Windows installs cannot load that optional binary.
  // A constructible matrix is sufficient for the module's non-rendering path.
  if (!("DOMMatrix" in globalThis)) {
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: class TextExtractionDOMMatrix {},
    });
  }
  return (await import("pdf-parse")).PDFParse;
}

export class ScopedFileService {
  private readonly roots: string[];

  private constructor(roots: string[]) {
    this.roots = roots;
  }

  static async create(configuredRoots: string[]): Promise<ScopedFileService> {
    if (configuredRoots.length === 0) throw new Error("At least one allowed file root is required");
    const roots: string[] = [];
    for (const root of configuredRoots) {
      const actual = await realpath(resolve(root));
      const metadata = await stat(actual);
      if (!metadata.isDirectory()) throw new Error(`Allowed root is not a directory: ${root}`);
      if (!roots.some((existing) => within(existing, actual))) roots.push(actual);
    }
    return new ScopedFileService(roots);
  }

  allowedRoots(): string[] {
    return [...this.roots];
  }

  async listDirectory(input: string): Promise<FileEntry[]> {
    const path = await this.existing(input);
    const metadata = await stat(path);
    if (!metadata.isDirectory()) throw new Error("Path is not a directory");
    const entries = await readdir(path, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const entry of entries.slice(0, 300)) {
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
      const child = resolve(path, entry.name);
      const childStat = await stat(child);
      result.push({
        name: entry.name,
        path: child,
        type: entry.isDirectory() ? "directory" : "file",
        size: entry.isFile() ? childStat.size : undefined,
        modifiedAt: childStat.mtime.toISOString(),
      });
    }
    return result.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, "zh-CN"));
  }

  async fileInfo(input: string): Promise<FileEntry> {
    const path = await this.existing(input);
    const metadata = await stat(path);
    return {
      name: basename(path),
      path,
      type: metadata.isDirectory() ? "directory" : "file",
      size: metadata.isFile() ? metadata.size : undefined,
      modifiedAt: metadata.mtime.toISOString(),
    };
  }

  async readText(input: string, maxChars = 30_000): Promise<{ path: string; text: string; truncated: boolean }> {
    const path = await this.existing(input);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("Path is not a file");
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) throw new Error("Only recognized text files can be read by this tool");
    if (metadata.size > 2 * 1024 * 1024) throw new Error("Text file exceeds the 2 MB read limit");
    const text = await readFile(path, "utf8");
    if (text.includes("\0")) throw new Error("File appears to be binary");
    return { path, text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }

  async parseDocument(input: string, maxChars = 50_000): Promise<ParsedDocument> {
    const path = await this.existing(input);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("Path is not a file");
    if (metadata.size > 30 * 1024 * 1024) throw new Error("Document exceeds the 30 MB parsing limit");
    const extension = extname(path).toLowerCase();
    const bytes = await readFile(path);
    let text = "";
    let format: ParsedDocument["format"];
    let details: Record<string, unknown> = {};
    if (extension === ".pdf") {
      format = "pdf";
      const PDFParse = await loadPdfParser();
      const parser = new PDFParse({ data: bytes });
      try {
        const result = await parser.getText({ first: 100 });
        text = result.text;
        details = { pages: result.total, parsedPages: result.pages.length };
      } finally {
        await parser.destroy();
      }
    } else if (extension === ".docx") {
      format = "docx";
      const result = await mammoth.extractRawText({ buffer: bytes });
      text = result.value;
      details = { warnings: result.messages.map((message) => message.message).slice(0, 10) };
    } else if (extension === ".xlsx") {
      format = "xlsx";
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes);
      const lines: string[] = [];
      const sheets = workbook.worksheets.slice(0, 20);
      for (const worksheet of sheets) {
        lines.push(`[工作表：${worksheet.name}]`);
        let rows = 0;
        worksheet.eachRow({ includeEmpty: false }, (row) => {
          if (rows++ >= 500 || lines.join("\n").length >= maxChars * 2) return;
          const values: string[] = [];
          row.eachCell({ includeEmpty: true }, (cell) => values.push(cell.text));
          lines.push(values.join("\t"));
        });
      }
      text = lines.join("\n");
      details = { sheets: workbook.worksheets.length, parsedSheets: sheets.length };
    } else {
      throw new Error("Document parser supports PDF, DOCX, and XLSX only");
    }
    const normalized = text.trim();
    if (!normalized) throw new Error("No extractable text was found; this may be a scanned document that needs OCR");
    return { path, format, text: normalized.slice(0, maxChars), truncated: normalized.length > maxChars, details };
  }

  async search(query: string, maxResults = 50): Promise<FileEntry[]> {
    const needle = query.trim().toLowerCase();
    if (!needle || needle.length > 200) throw new Error("Search query must be between 1 and 200 characters");
    const results: FileEntry[] = [];
    let visited = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 8 || visited >= 10_000 || results.length >= maxResults) return;
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (visited++ >= 10_000 || results.length >= maxResults) break;
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
        const path = resolve(directory, entry.name);
        if (entry.name.toLowerCase().includes(needle)) results.push(await this.fileInfo(path));
        if (entry.isDirectory()) await walk(path, depth + 1);
      }
    };
    for (const root of this.roots) await walk(root, 0);
    return results;
  }

  async createDirectory(input: string): Promise<string> {
    const path = await this.newPath(input);
    await mkdir(path);
    return path;
  }

  async move(sourceInput: string, destinationInput: string): Promise<{ source: string; destination: string }> {
    const source = await this.existing(sourceInput);
    const destination = await this.newPath(destinationInput);
    await rename(source, destination);
    return { source, destination };
  }

  async cacheDownloadedImage(bytes: Buffer, mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"): Promise<string> {
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) throw new Error("Downloaded image must be between 1 byte and 10 MB");
    const pictureRoot = this.roots.find((root) => basename(root).toLowerCase() === "pictures") ?? this.roots[0];
    const directory = resolve(pictureRoot, "EmiliaDownloads");
    await mkdir(directory, { recursive: true });
    const extension = ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" } as const)[mediaType];
    const path = resolve(directory, `${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}${extension}`);
    try {
      await writeFile(path, bytes, { flag: "wx" });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const existing = await stat(path);
      if (!existing.isFile() || existing.size !== bytes.length) throw new Error("Cached image path conflicts with another file");
    }
    return path;
  }

  private async existing(input: string): Promise<string> {
    if (!isAbsolute(input)) throw new Error("Use an absolute path inside an allowed folder");
    const actual = await realpath(resolve(input));
    if (!this.roots.some((root) => within(root, actual))) throw new Error("Resolved path escapes the allowed folders");
    return actual;
  }

  private async newPath(input: string): Promise<string> {
    if (!isAbsolute(input)) throw new Error("Use an absolute path inside an allowed folder");
    const lexical = resolve(input);
    const actualParent = await realpath(dirname(lexical));
    const path = resolve(actualParent, basename(lexical));
    if (!this.roots.some((root) => within(root, path)) || this.roots.includes(path)) {
      throw new Error("Destination is outside the allowed folders or is an allowed root");
    }
    try {
      await stat(path);
      throw new Error("Destination already exists; overwriting is not allowed");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return path;
      throw error;
    }
  }
}

export function loadAllowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.COMPANION_FILE_ROOTS ?? "").split(";").map((value) => value.trim()).filter(Boolean);
}

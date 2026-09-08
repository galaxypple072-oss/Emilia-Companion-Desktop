import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScopedFileService } from "../src/file-service.ts";
import ExcelJS from "exceljs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function minimalPdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length + 34} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

test("scopes file reads and organization to explicit roots without overwrite", async () => {
  const base = await mkdtemp(join(tmpdir(), "companion-files-"));
  const root = join(base, "allowed");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, "notes.txt"), "hello world", "utf8");
  await writeFile(join(outside, "secret.txt"), "secret", "utf8");
  try {
    const files = await ScopedFileService.create([root]);
    assert.equal((await files.listDirectory(root))[0].name, "notes.txt");
    assert.equal((await files.readText(join(root, "notes.txt"))).text, "hello world");
    assert.equal((await files.search("notes"))[0].name, "notes.txt");
    await assert.rejects(files.readText(join(outside, "secret.txt")), /allowed|escapes/u);
    const folder = join(root, "archive");
    await files.createDirectory(folder);
    const moved = join(folder, "renamed.txt");
    await files.move(join(root, "notes.txt"), moved);
    assert.equal((await files.readText(moved)).text, "hello world");
    await writeFile(join(root, "occupied.txt"), "x", "utf8");
    await assert.rejects(files.move(moved, join(root, "occupied.txt")), /already exists/u);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("parses PDF, DOCX, and XLSX locally inside an allowed root", async () => {
  const base = await mkdtemp(join(tmpdir(), "companion-docs-"));
  try {
    await writeFile(join(base, "sample.pdf"), minimalPdf("Hello PDF"));
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../../node_modules/mammoth/test/test-data/single-paragraph.docx");
    await writeFile(join(base, "sample.docx"), await import("node:fs/promises").then(({ readFile }) => readFile(fixture)));
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Sheet1").addRow(["Name", "Value"]);
    workbook.getWorksheet("Sheet1")!.addRow(["Alice", 42]);
    await workbook.xlsx.writeFile(join(base, "sample.xlsx"));

    const files = await ScopedFileService.create([base]);
    assert.match((await files.parseDocument(join(base, "sample.pdf"))).text, /Hello PDF/u);
    assert.ok((await files.parseDocument(join(base, "sample.docx"))).text.length > 0);
    assert.match((await files.parseDocument(join(base, "sample.xlsx"))).text, /Alice\t42/u);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("caches downloaded images inside a dedicated allowed-folder directory", async () => {
  const base = await mkdtemp(join(tmpdir(), "companion-images-"));
  const pictures = join(base, "pictures");
  await mkdir(pictures);
  try {
    const files = await ScopedFileService.create([pictures]);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const first = await files.cacheDownloadedImage(png, "image/png");
    const second = await files.cacheDownloadedImage(png, "image/png");
    assert.equal(first, second);
    assert.match(first, /pictures[\\/]EmiliaDownloads[\\/][a-f0-9]{24}\.png$/u);
    assert.equal((await files.fileInfo(first)).size, png.length);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

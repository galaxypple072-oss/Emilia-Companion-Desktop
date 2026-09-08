import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { inspect } from "node:util";

function render(value: unknown): string {
  return typeof value === "string" ? value : inspect(value, { depth: 5, breakLength: 120 });
}

export function installCoreFileLogging(dataDir: string): string {
  const logDirectory = resolve(dataDir, "logs");
  const logPath = resolve(logDirectory, "product-core.log");
  const previousLogPath = resolve(logDirectory, "product-core.1.log");
  mkdirSync(logDirectory, { recursive: true });
  if (existsSync(logPath) && statSync(logPath).size >= 5 * 1024 * 1024) {
    rmSync(previousLogPath, { force: true });
    renameSync(logPath, previousLogPath);
  }

  const write = (level: string, values: unknown[]): void => {
    const line = `${new Date().toISOString()} ${level} ${values.map(render).join(" ")}\n`;
    appendFileSync(logPath, line, { encoding: "utf8" });
  };
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.log = (...values: unknown[]) => {
    write("INFO", values);
    originalLog(...values);
  };
  console.warn = (...values: unknown[]) => {
    write("WARN", values);
    originalWarn(...values);
  };
  console.error = (...values: unknown[]) => {
    write("ERROR", values);
    originalError(...values);
  };
  return logPath;
}

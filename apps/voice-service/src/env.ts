import { readFileSync } from "node:fs";

/** Deliberately tiny .env reader so the Windows voice service can live beside
 * GPT-SoVITS without requiring the whole Companion repository at runtime. */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const source = readFileSync(path, "utf8");
    for (const line of source.split(/\r?\n/u)) {
      if (!line || /^\s*#/u.test(line)) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key && env[key] === undefined) env[key] = value.replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

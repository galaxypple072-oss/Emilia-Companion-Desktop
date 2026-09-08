import { resolve } from "node:path";

export interface ProductCoreConfig {
  dataDir: string;
  databasePath: string;
  pollIntervalMs: number;
  reconnectDelayMs: number;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected an integer between ${min} and ${max}, received ${value}`);
  }
  return parsed;
}

export function loadProductCoreConfig(env: NodeJS.ProcessEnv = process.env): ProductCoreConfig {
  const defaultDataDir = env.LOCALAPPDATA
    ? resolve(env.LOCALAPPDATA, "PersonalCompanion")
    : resolve(process.cwd(), "data");
  const dataDir = resolve(env.CORE_DATA_DIR?.trim() || defaultDataDir);
  return {
    dataDir,
    databasePath: resolve(dataDir, "product-core.sqlite"),
    pollIntervalMs: boundedInteger(env.CORE_POLL_INTERVAL_MS, 1000, 100, 60_000),
    reconnectDelayMs: boundedInteger(env.CORE_RECONNECT_DELAY_MS, 5000, 500, 60_000),
  };
}

export function parseDelay(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/u.exec(value.trim());
  if (!match) throw new Error("Delay must look like 30s, 10m, 2h, or 1d");
  const amount = Number(match[1]);
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  const result = amount * multiplier;
  if (result < 1000 || result > 365 * 86_400_000) {
    throw new Error("Delay must be between 1 second and 365 days");
  }
  return result;
}

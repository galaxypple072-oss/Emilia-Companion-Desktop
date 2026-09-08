import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../apps/qq-gateway/src/config.ts";
import { parseDotEnv } from "../apps/qq-gateway/src/env.ts";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const host = option(process.argv.slice(2), "--host");
if (!host || !/^[a-zA-Z0-9.-]+$/u.test(host)) {
  console.error("Usage: node scripts/retarget-onebot-env.ts --host HOST");
  process.exit(1);
}

try {
  const envPath = resolve(process.cwd(), ".env");
  const values = parseDotEnv(readFileSync(envPath, "utf8"));
  const current = loadConfig(values);
  const http = new URL(current.httpUrl);
  const websocket = new URL(current.wsUrl);
  http.hostname = host;
  websocket.hostname = host;

  const next = [
    `ONEBOT_HTTP_URL=${http.toString().replace(/\/$/u, "")}`,
    `ONEBOT_WS_URL=${websocket.toString().replace(/\/$/u, "")}`,
    `ONEBOT_ACCESS_TOKEN=${current.accessToken}`,
    `ONEBOT_ALLOWED_QQ=${[...current.allowedQQs].join(",")}`,
    `ONEBOT_REQUEST_TIMEOUT_MS=${current.requestTimeoutMs}`,
    "",
  ].join("\n");

  const temporaryPath = `${envPath}.tmp`;
  writeFileSync(temporaryPath, next, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporaryPath, envPath);
  chmodSync(envPath, 0o600);
  console.log(`Retargeted OneBot HTTP and WebSocket endpoints to ${host} (token hidden).`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[retarget-onebot-env] ${message}`);
  process.exitCode = 1;
}

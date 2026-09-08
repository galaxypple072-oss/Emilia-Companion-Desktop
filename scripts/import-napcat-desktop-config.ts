import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseQQId } from "../apps/qq-gateway/src/config.ts";

interface ServerConfig {
  enable?: boolean;
  port?: number;
  token?: string;
}

interface DesktopConfig {
  bots?: Array<{
    connect?: {
      httpServers?: ServerConfig[];
      websocketServers?: ServerConfig[];
    };
  }>;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function enabledServer(servers: ServerConfig[] | undefined, type: string): ServerConfig {
  const server = servers?.find((candidate) => candidate.enable !== false);
  if (!server || !Number.isInteger(server.port) || !server.token) {
    throw new Error(`No enabled ${type} server with a port and token was found`);
  }
  return server;
}

const args = process.argv.slice(2);
const configPath = option(args, "--config");
const ownerFile = option(args, "--owner-file");
const host = option(args, "--host");

if (!configPath || !ownerFile || !host) {
  console.error(
    "Usage: node scripts/import-napcat-desktop-config.ts --config PATH --owner-file PATH --host HOST",
  );
  process.exit(1);
}

try {
  const desktop = JSON.parse(readFileSync(configPath, "utf8")) as DesktopConfig;
  if (desktop.bots?.length !== 1) {
    throw new Error("Expected exactly one NapCat Desktop bot");
  }

  const http = enabledServer(desktop.bots[0].connect?.httpServers, "HTTP");
  const websocket = enabledServer(desktop.bots[0].connect?.websocketServers, "WebSocket");
  if (http.token !== websocket.token) {
    throw new Error("HTTP and WebSocket access tokens do not match");
  }

  const ownerQQ = parseQQId(readFileSync(ownerFile, "utf8").trim());
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    throw new Error(`${envPath} already exists; refusing to overwrite credentials`);
  }

  writeFileSync(
    envPath,
    [
      `ONEBOT_HTTP_URL=http://${host}:${http.port}`,
      `ONEBOT_WS_URL=ws://${host}:${websocket.port}`,
      `ONEBOT_ACCESS_TOKEN=${http.token}`,
      `ONEBOT_ALLOWED_QQ=${ownerQQ}`,
      "ONEBOT_REQUEST_TIMEOUT_MS=10000",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  chmodSync(envPath, 0o600);
  console.log("Imported NapCat Desktop endpoints and credentials into .env (mode 0600).");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[import-napcat-desktop-config] ${message}`);
  process.exitCode = 1;
}

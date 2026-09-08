import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseQQId } from "../apps/qq-gateway/src/config.ts";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function randomToken(): string {
  return randomBytes(24).toString("hex");
}

function writePrivateFile(path: string, contents: string): void {
  if (existsSync(path)) {
    throw new Error(`${path} already exists; refusing to overwrite credentials`);
  }
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

const mainQQ = option(process.argv.slice(2), "--main-qq");
if (!mainQQ) {
  console.error("Usage: pnpm napcat:prepare --main-qq YOUR_PRIMARY_QQ");
  process.exit(1);
}

try {
  const allowedQQ = parseQQId(mainQQ);
  const webuiToken = randomToken();
  const oneBotToken = randomToken();

  writePrivateFile(
    resolve(process.cwd(), ".env.napcat"),
    [
      `NAPCAT_UID=${typeof process.getuid === "function" ? process.getuid() : 1000}`,
      `NAPCAT_GID=${typeof process.getgid === "function" ? process.getgid() : 1000}`,
      `NAPCAT_WEBUI_TOKEN=${webuiToken}`,
      "",
    ].join("\n"),
  );

  writePrivateFile(
    resolve(process.cwd(), ".env"),
    [
      "ONEBOT_HTTP_URL=http://127.0.0.1:3000",
      "ONEBOT_WS_URL=ws://127.0.0.1:3001",
      `ONEBOT_ACCESS_TOKEN=${oneBotToken}`,
      `ONEBOT_ALLOWED_QQ=${allowedQQ}`,
      "ONEBOT_REQUEST_TIMEOUT_MS=10000",
      "",
    ].join("\n"),
  );

  console.log("Created .env.napcat and .env with mode 0600.");
  console.log("The OneBot token is stored in .env; copy it into NapCat network settings.");
  console.log("Credentials were intentionally not printed to the terminal.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[napcat:prepare] ${message}`);
  process.exitCode = 1;
}

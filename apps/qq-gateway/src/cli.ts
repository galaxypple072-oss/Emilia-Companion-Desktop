import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { loadDotEnv } from "./env.ts";
import { OneBotClient } from "./onebot-client.ts";
import { listenForPrivateMessages } from "./onebot-events.ts";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): string {
  return `Usage:
  pnpm qq:status
  pnpm qq:send --to <QQ> --text <message>
  pnpm qq:listen [--echo] [--once]

Configuration is loaded from .env in the project root.`;
}

async function main(): Promise<void> {
  loadDotEnv(resolve(process.cwd(), ".env"));

  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }

  const config = loadConfig();
  const client = new OneBotClient(config);

  if (command === "status") {
    const [status, login] = await Promise.all([client.getStatus(), client.getLoginInfo()]);
    console.log(
      JSON.stringify(
        {
          connected: true,
          endpoint: config.httpUrl,
          login,
          status,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "send") {
    const to = option(args, "--to");
    const text = option(args, "--text");
    if (!to || !text) {
      throw new Error("send requires --to <QQ> and --text <message>");
    }
    const result = await client.sendPrivateMessage(to, text);
    console.log(JSON.stringify({ sent: true, recipient: to, result }, null, 2));
    return;
  }

  if (command === "listen") {
    await listenForPrivateMessages(config, client, {
      echo: args.includes("--echo"),
      once: args.includes("--once"),
    });
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[qq-gateway] ${message}`);
  process.exitCode = 1;
});

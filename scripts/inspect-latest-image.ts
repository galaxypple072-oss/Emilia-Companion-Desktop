import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadDotEnv } from "../apps/qq-gateway/src/env.ts";
import { loadConfig } from "../apps/qq-gateway/src/config.ts";
import { loadProductCoreConfig } from "../apps/product-core/src/config.ts";

loadDotEnv(resolve(process.cwd(), ".env"));
const oneBot = loadConfig();
const core = loadProductCoreConfig();
const database = new DatabaseSync(core.databasePath, { readOnly: true });
try {
  const row = database.prepare(`
    SELECT external_message_id FROM inbound_messages WHERE body LIKE '[图片]%'
    ORDER BY received_at DESC LIMIT 1
  `).get() as { external_message_id: string } | undefined;
  if (!row) throw new Error("No image message found");
  const response = await fetch(`${oneBot.httpUrl}/get_msg`, {
    method: "POST",
    headers: { authorization: `Bearer ${oneBot.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ message_id: Number(row.external_message_id) }),
  });
  const payload = await response.json() as { data?: { message?: unknown; raw_message?: unknown } };
  console.log(JSON.stringify({ message_id: row.external_message_id, message: payload.data?.message, raw_message: payload.data?.raw_message }, null, 2));
} finally {
  database.close();
}

import assert from "node:assert/strict";
import test from "node:test";
import { assertAllowedQQ, loadConfig } from "../src/config.ts";
import { parseDotEnv } from "../src/env.ts";

const validEnv = {
  ONEBOT_HTTP_URL: "http://127.0.0.1:3000",
  ONEBOT_WS_URL: "ws://127.0.0.1:3001",
  ONEBOT_ACCESS_TOKEN: "0123456789abcdef0123456789abcdef",
  ONEBOT_ALLOWED_QQ: "12345678, 87654321",
};

test("loads a secure allowlisted configuration", () => {
  const config = loadConfig(validEnv);
  assert.equal(config.httpUrl, "http://127.0.0.1:3000");
  assert.deepEqual([...config.allowedQQs], ["12345678", "87654321"]);
  assert.equal(assertAllowedQQ(config, "12345678"), "12345678");
  assert.throws(() => assertAllowedQQ(config, "11111111"), /not present/u);
});

test("rejects weak tokens and invalid QQ IDs", () => {
  assert.throws(
    () => loadConfig({ ...validEnv, ONEBOT_ACCESS_TOKEN: "short" }),
    /at least 16/u,
  );
  assert.throws(
    () => loadConfig({ ...validEnv, ONEBOT_ALLOWED_QQ: "not-a-qq" }),
    /Invalid QQ/u,
  );
});

test("parses quoted .env values without overriding syntax", () => {
  assert.deepEqual(
    parseDotEnv('A=one\nB="two words"\n# ignored\nC=three=four\n'),
    { A: "one", B: "two words", C: "three=four" },
  );
});

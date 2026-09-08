import assert from "node:assert/strict";
import test from "node:test";
import { emiliaAnchorContext } from "../src/emilia-anchors.ts";

test("selects a small set of situation guidance rather than canned dialogue", () => {
  const context = emiliaAnchorContext("老板又让我加班，我真的累死了");
  assert.match(context, /用户疲惫/u);
  assert.match(context, /用户抱怨工作/u);
  assert.match(context, /不是可复读的台词模板/u);
  assert.doesNotMatch(context, /又忙到现在/u);
});

test("keeps unrelated chat free of forced anchors", () => {
  assert.equal(emiliaAnchorContext("今天阳光不错"), "");
});

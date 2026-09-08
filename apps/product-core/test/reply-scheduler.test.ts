import assert from "node:assert/strict";
import test from "node:test";
import { ReplyScheduler } from "../src/reply-scheduler.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("coalesces messages arriving inside the quiet window", async () => {
  let revision = 0;
  const executed: number[] = [];
  const scheduler = new ReplyScheduler(
    () => revision,
    async (value) => { executed.push(value); },
    (error) => { throw error; },
    { quietMs: 25, maxWaitMs: 100 },
  );
  revision = 1;
  scheduler.notify();
  await sleep(10);
  revision = 2;
  scheduler.notify();
  await sleep(35);
  await scheduler.waitForIdle();
  assert.deepEqual(executed, [2]);
});

test("serializes reply generation", async () => {
  let revision = 1;
  const events: string[] = [];
  const scheduler = new ReplyScheduler(
    () => revision,
    async (value) => {
      events.push(`start:${value}`);
      await sleep(20);
      events.push(`end:${value}`);
    },
    (error) => { throw error; },
    { quietMs: 5, maxWaitMs: 20 },
  );
  scheduler.notify();
  await sleep(8);
  revision = 2;
  scheduler.notify();
  await sleep(35);
  await scheduler.waitForIdle();
  assert.deepEqual(events, ["start:1", "end:1", "start:2", "end:2"]);
});

test("marks an active reply stale when a continuation arrives", async () => {
  let revision = 1;
  const committed: number[] = [];
  const started: number[] = [];
  const scheduler = new ReplyScheduler(
    () => revision,
    async (value, context) => {
      started.push(value);
      await sleep(20);
      if (context.isCurrent()) committed.push(value);
    },
    (error) => { throw error; },
    { quietMs: 5, maxWaitMs: 30 },
  );
  scheduler.notify();
  await sleep(8);
  revision = 2;
  scheduler.notify();
  await sleep(40);
  await scheduler.waitForIdle();
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(committed, [2]);
});

test("aborts an active generation as soon as a newer message arrives", async () => {
  let revision = 1;
  const events: string[] = [];
  const scheduler = new ReplyScheduler(
    () => revision,
    async (value, context) => {
      events.push(`start:${value}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        context.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          events.push(`abort:${value}`);
          resolve();
        }, { once: true });
      });
      if (context.isCurrent()) events.push(`commit:${value}`);
    },
    (error) => { throw error; },
    { quietMs: 5, maxWaitMs: 30 },
  );
  scheduler.notify();
  await sleep(8);
  revision = 2;
  scheduler.notify();
  await sleep(115);
  await scheduler.waitForIdle();
  assert.deepEqual(events, ["start:1", "abort:1", "start:2", "commit:2"]);
});

test("skips a queued capture superseded before it starts", async () => {
  let revision = 1;
  const captured: number[] = [];
  const scheduler = new ReplyScheduler(
    () => { captured.push(revision); return revision; },
    async () => { await sleep(20); },
    (error) => { throw error; },
    { quietMs: 5, maxWaitMs: 30 },
  );
  scheduler.notify();
  await sleep(8);
  revision = 2;
  scheduler.notify();
  await sleep(7);
  revision = 3;
  scheduler.notify();
  await sleep(45);
  await scheduler.waitForIdle();
  assert.deepEqual(captured, [1, 3]);
});

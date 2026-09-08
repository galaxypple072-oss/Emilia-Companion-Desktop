import assert from "node:assert/strict";
import test from "node:test";
import { handleCoreCommand } from "../src/commands.ts";
import { ProductStore } from "../src/store.ts";

test("creates, lists, completes, cancels, and snoozes durable tasks", () => {
  const store = new ProductStore(":memory:");
  try {
    const first = store.createTask({ title: "发送方案", dueAt: 10_000, sourceKey: "msg-1", now: 1000 });
    assert.equal(first.created, true);
    assert.equal(store.createTask({ title: "重复", sourceKey: "msg-1", now: 2000 }).created, false);
    assert.equal(store.listTasks()[0].title, "发送方案");
    assert.equal(store.snoozeTask(first.task.id.slice(0, 8), 20_000, 3000).dueAt, 20_000);
    assert.equal(store.completeTask(first.task.id.slice(0, 8), 4000).status, "completed");
    const second = store.createTask({ title: "购买配件", now: 5000 }).task;
    assert.equal(store.cancelTask(second.id.slice(0, 8), 6000).status, "cancelled");
    assert.equal(store.listTasks().length, 0);
  } finally {
    store.close();
  }
});

test("queues one deduplicated notification for each task stage", () => {
  const store = new ProductStore(":memory:");
  try {
    const task = store.createTask({ title: "交报告", dueAt: 10_000_000, now: 1000 }).task;
    assert.equal(store.queueNextTaskNotification("123456789", 6_399_999), null);
    assert.equal(store.queueNextTaskNotification("123456789", 6_400_000)!.stage, "upcoming");
    assert.equal(store.queueNextTaskNotification("123456789", 6_500_000), null);
    assert.equal(store.queueNextTaskNotification("123456789", 10_000_000)!.stage, "due");
    assert.equal(store.queueNextTaskNotification("123456789", 20_800_000)!.stage, "overdue");
    assert.equal(store.queueNextTaskNotification("123456789", 21_000_000), null);
    const bodies = [store.claimDue(30_000_000)!, store.claimDue(30_000_000)!, store.claimDue(30_000_000)!].map((item) => item.body);
    assert.match(bodies.join("\n"), /快到时间/u);
    assert.match(bodies.join("\n"), /到时间/u);
    assert.match(bodies.join("\n"), /还没有标记完成/u);
    assert.match(bodies.join("\n"), new RegExp(task.id.slice(0, 8), "u"));
  } finally {
    store.close();
  }
});

test("task slash commands provide deterministic control", () => {
  const store = new ProductStore(":memory:");
  try {
    const created = handleCoreCommand("/todo 2h 整理项目资料", store, "123456789", 1000);
    assert.match(created.reply!, /任务已记下/u);
    const task = store.listTasks()[0];
    assert.match(handleCoreCommand("/tasks", store, "123456789", 2000).reply!, /整理项目资料/u);
    assert.match(handleCoreCommand(`/snooze ${task.id.slice(0, 8)} 1h`, store, "123456789", 3000).reply!, /已推迟/u);
    assert.match(handleCoreCommand(`/done ${task.id.slice(0, 8)}`, store, "123456789", 4000).reply!, /完成啦/u);
  } finally {
    store.close();
  }
});

test("explicit conversational reminders become one durable task without a slash command", () => {
  const store = new ProductStore(":memory:");
  try {
    const now = 1_000_000;
    const result = handleCoreCommand("两小时后提醒我交报告", store, "123456789", now, "message-1");
    assert.equal(result.handled, true);
    assert.match(result.reply!, /提醒你/u);
    assert.equal(store.listTasks()[0].title, "交报告");
    assert.equal(store.listTasks()[0].dueAt, now + 2 * 3_600_000);
    assert.match(handleCoreCommand("两小时后提醒我交报告", store, "123456789", now, "message-1").reply!, /已经记着/u);
    assert.equal(store.listTasks().length, 1);
  } finally {
    store.close();
  }
});

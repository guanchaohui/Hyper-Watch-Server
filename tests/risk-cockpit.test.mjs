import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { day, positionLiquidation, positionRiskSummary, utc8DayStart } from "../dist/server/analytics.js";
import worker from "../dist/server/index.js";

test("全市场、默认市场和断线时的强平风险口径独立", () => {
  const long = { coin: "BTC", size: 1, mark: 100, liquidation: 95, value: 100, margin: 20 };
  const short = { coin: "xyz:NVDA", size: -1, mark: 200, liquidation: 206, value: 200, margin: 50 };
  assert.deepEqual(positionRiskSummary([long, short], { complete: true, fresh: true }), {
    level: "critical", closest: { row: short, gap: 3 }, complete: true, notional: 300, margin: 70,
  });
  const near = { ...long, liquidation: 88 };
  assert.equal(positionRiskSummary([near], { fresh: true }).level, "watch");
  const far = { ...long, liquidation: 80 };
  assert.equal(positionRiskSummary([far], { fresh: true }).level, "unknown");
  assert.equal(positionRiskSummary([far], { complete: true, fresh: true }).level, "low");
  assert.equal(positionRiskSummary([long], { complete: true, fresh: false }).level, "unknown");
  const missing = { ...short, liquidation: null, margin: null, value: null };
  const partial = positionRiskSummary([far, missing], { complete: true, fresh: true });
  assert.equal(partial.level, "unknown");
  assert.equal(partial.margin, null);
  assert.equal(partial.notional, null);
  assert.equal(positionRiskSummary([], { complete: true, fresh: true }).level, "flat");
  assert.equal(positionRiskSummary([], { complete: false, fresh: true }).level, "unknown");
  assert.equal(positionRiskSummary(null).margin, null);
});

test("概览活动按登录账户隔离，共享公开缓存，今日盈亏去重并分开资金流水", async t => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("CREATE TABLE alerts (user_id TEXT, event_id TEXT, created_at INTEGER)");
  sqlite.exec("CREATE TABLE profiles (user_id TEXT, settings TEXT)");
  const DB = { prepare(sql) {
    const stmt = sqlite.prepare(sql);
    return { bind: (...args) => ({ first: () => stmt.get(...args), all: () => ({ results: stmt.all(...args) }) }) };
  } };
  const wallet = "0x" + "a".repeat(40);
  const other = "0x" + "b".repeat(40);
  const partial = "0x" + "c".repeat(40);
  const now = Date.parse("2026-11-19T00:00:00.000Z");
  const midnight = utc8DayStart(now);
  t.mock.method(Date, "now", () => now);
  const record = sqlite.prepare("INSERT INTO alerts VALUES (?, ?, ?)");
  record.run("alpha", "risk:" + wallet + ":1", now - 1);
  record.run("alpha", "equity:" + other + ":1", now - 2);
  record.run("beta", "leverage:" + wallet + ":1", now - 3);
  const fill = (tid, time, closedPnl, fields = {}) => ({
    tid, time, closedPnl, coin: "BTC", dir: "Close Long", side: "A", oid: tid,
    startPosition: "1", sz: "1", px: "2000", ...fields,
  });
  const close = fill(1, midnight + 1000, "20");
  const opening = fill(2, midnight + 2000, "-1", { coin: "xyz:NVDA", startPosition: "0", side: "B", dir: "Open Long" });
  const previous = fill(3, midnight - 1000, "999");
  const spot = fill(4, midnight + 3000, "888", { coin: "@107" });
  const deposit = { hash: "deposit", time: midnight + 4000, delta: { type: "deposit", usdc: "500" } };
  const withdraw = { hash: "withdraw", time: midnight + 5000, delta: { type: "withdraw", usdc: "201" } };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_, init) => {
    const body = JSON.parse(init.body);
    requests.push(body.type);
    assert.equal(body.startTime, now - day);
    assert.equal(body.endTime, now);
    if (body.type === "userFillsByTime") {
      assert.equal(body.aggregateByTime, false);
      if (body.user === other) return Response.json(Array(500).fill(close));
      if (body.user === partial) return Response.json([fill(7, midnight + 1000, null)]);
      return Response.json([close, close, opening, previous, spot]);
    }
    assert.equal(body.type, "userNonFundingLedgerUpdates");
    return Response.json([deposit, deposit, withdraw, { time: midnight + 6000, delta: { type: "internalTransfer", usdc: "700" } }]);
  });
  const call = (user, address, claimed = user) => worker.fetch(new Request(
    "https://hyper.invalid/api/overview-activity?" + new URLSearchParams({ wallet: address }),
    { headers: { "oai-authenticated-user-id": user, "x-hyper-account": claimed } },
  ), { DB });
  assert.equal((await call("alpha", wallet, "beta")).status, 401);
  assert.equal((await call("alpha", "not-an-address")).status, 400);
  assert.equal(requests.length, 0);
  const alpha = await (await call("alpha", wallet)).json();
  const beta = await (await call("beta", wallet)).json();
  assert.equal(alpha.realized, 19);
  assert.equal(alpha.todayStart, midnight);
  assert.equal(alpha.fillsState, "ready");
  assert.equal(alpha.events.filter(row => row.type === "deposit").length, 1);
  assert.ok(alpha.events.some(row => row.type === "withdraw" && row.amount === 201));
  assert.ok(alpha.events.some(row => row.type === "risk"));
  assert.ok(!alpha.events.some(row => row.type === "equity" || row.type === "leverage" || row.type === "internalTransfer"));
  assert.ok(beta.events.some(row => row.type === "leverage"));
  assert.ok(!beta.events.some(row => row.type === "risk"));
  assert.equal(requests.length, 2);
  const capped = await (await call("alpha", other)).json();
  assert.equal(capped.fillsState, "limited");
  assert.equal(capped.realized, null);
  const missing = await (await call("alpha", partial)).json();
  assert.equal(missing.fillsState, "incomplete");
  assert.equal(missing.realized, null);
});

test("全仓共享保证金与逐仓缺失分别展示，同样本给出最接近强平的仓位", () => {
  const isolated = { coin: "xyz:IREN", size: 2, value: 200, margin: 50, mark: 100, liquidation: 92.8, mode: "isolated" };
  const cross = { coin: "HYPE", size: 4, value: 80, margin: 20, mark: 20, liquidation: null, mode: "cross" };
  const incomplete = { ...isolated, mark: null };
  const missing = { ...isolated, liquidation: null };
  assert.equal(positionLiquidation(isolated).level, "watch");
  assert.equal(positionLiquidation(cross).state, "shared");
  assert.equal(positionLiquidation({ ...cross, liquidation: 10 }).state, "priced");
  assert.equal(positionLiquidation(incomplete).state, "unavailable");
  assert.equal(positionLiquidation(missing).state, "unavailable");
  const result = positionRiskSummary([cross, isolated], { complete: true, fresh: true });
  assert.equal(result.closest.row, isolated);
  assert.equal(result.closest.gap, positionLiquidation(isolated).gap);
  assert.equal(result.margin, 70);
  assert.equal(result.notional, 280);
});

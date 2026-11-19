import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { day, positionTotals, utc8DayStart } from "../dist/server/analytics.js";
import worker from "../dist/server/index.js";
import { parsePositions } from "../dist/server/market.js";

test("仓位概况按快照汇总，不将缺失保证金作零处理", () => {
  assert.deepEqual(positionTotals([{ value: 100, margin: 30 }, { value: 60, margin: 7 }]), { notional: 160, margin: 37 });
  assert.deepEqual(positionTotals([{ value: null, margin: 30 }]), { notional: null, margin: 30 });
  assert.deepEqual(positionTotals([]), { notional: 0, margin: 0 });
  assert.deepEqual(positionTotals(null), { notional: null, margin: null });
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

test("强平价保留 Hyperliquid 原始精度，缺失时全仓、逐仓都不补值", () => {
  const rows = [{ coin: "xyz:IREN", liquidationPx: "92.800012345", szi: "2" },
    { coin: "HYPE", liquidationPx: null, szi: "1", leverage: { type: "cross" } },
    { coin: "BTC", szi: "1", leverage: { type: "isolated" } },
    { coin: "ETH", liquidationPx: "-", szi: "2" },
    { coin: "SOL", liquidationPx: "0", szi: "3" }];
  const positions = parsePositions([["", { assetPositions: rows.map(position => ({ position })) }]]);
  assert.equal(positions[0].liquidationText, "92.800012345");
  assert.equal(positions[0].liquidation, 92.800012345);
  for (const row of positions.slice(1)) {
    assert.equal(row.liquidationText, null);
    assert.equal(row.liquidation, null);
  }
});

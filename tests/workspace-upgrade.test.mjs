import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { cleanProfile, filterPositions, tradingActivity } from "../dist/server/analytics.js";
import { parsePositions } from "../dist/server/market.js";
import worker from "../dist/server/index.js";

test("旧库迁移保留设置和提醒，游标分页及已读隔离到账户", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys = ON;");
    sqlite.exec(await readFile(new URL("../drizzle/0000_watchlist.sql", import.meta.url), "utf8"));
    sqlite.exec("ALTER TABLE alerts ADD COLUMN title TEXT");
    const address = "0x" + "a".repeat(40);
    const settings = JSON.stringify({ wallets: [{ address, pinned: true, group: "主组", role: "mine" }] });
    sqlite.prepare("INSERT INTO profiles VALUES (?, ?, ?)").run("alpha", settings, 7);
    const insert = sqlite.prepare("INSERT INTO alerts (user_id, event_id, body, created_at) VALUES (?, ?, ?, ?)");
    const now = Date.now();
    for (let i = 0; i < 22; i++) insert.run("alpha", "fill:" + i, "仓位更新", now);
    insert.run("alpha", "equity:1", "权益变化", now + 1);
    insert.run("beta", "fill:9", "其他账户", now + 2);
    insert.run("beta", "risk:private", "私有提醒", now + 3);
    const migration = await readFile(new URL("../drizzle/0001_alert_receipts.sql", import.meta.url), "utf8");
    sqlite.exec(migration);
    sqlite.exec(migration);
    sqlite.exec(await readFile(new URL("../drizzle/0004_alert_details.sql", import.meta.url), "utf8"));
    assert.deepEqual({ ...sqlite.prepare("SELECT settings, revision FROM profiles WHERE user_id = 'alpha'").get() }, { settings, revision: 7 });
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM alerts").get().count, 25);
    const DB = { prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bind = (...params) => ({
        first: () => statement.get(...params),
        all: () => ({ results: statement.all(...params) }),
        run: () => ({ meta: statement.run(...params) }),
      });
      return { ...bind(), bind };
    } };
    const call = (user, path, data, header = user) => worker.fetch(new Request("https://sample.test" + path, {
      method: data ? "PUT" : "GET",
      headers: { "oai-authenticated-user-id": user, "x-hyper-account": header, "content-type": "application/json" },
      ...(data ? { body: JSON.stringify(data) } : {}),
    }), { DB });
    const first = await (await call("alpha", "/api/inbox?kind=fill")).json();
    assert.equal(first.items.length, 20);
    const next = new URLSearchParams({ kind: "fill", before: first.next.time, event: first.next.id });
    const second = await (await call("alpha", "/api/inbox?" + next)).json();
    assert.equal(second.items.length, 2);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 22);
    assert.equal(second.next, null);
    await call("alpha", "/api/inbox/read", { id: "fill:9" });
    await call("alpha", "/api/inbox/read", { id: "fill:9" });
    await call("alpha", "/api/inbox/read", { id: "risk:private" });
    const beta = await (await call("beta", "/api/inbox?unread=1")).json();
    assert.equal(beta.items.length, 2);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM alert_reads").get().count, 1);
    const unread = await (await call("alpha", "/api/inbox?kind=fill&unread=1")).json();
    assert.ok(unread.items.every(item => item.id !== "fill:9"));
    assert.equal((await call("beta", "/api/inbox", null, "alpha")).status, 401);
    assert.equal((await call("beta", "/api/positions?wallet=" + address)).status, 404);
  } finally {
    sqlite.close();
  }
});

test("收藏独立于置顶，仓位兼容多市场消息并可按方向与浮亏筛选", () => {
  const base = { address: "0x" + "1".repeat(40), group: "观察", pinned: true, role: "mine" };
  assert.equal(cleanProfile({ wallets: [base] }).wallets[0].favorite, false);
  assert.deepEqual(cleanProfile({ wallets: [{ ...base, favorite: true }] }).wallets[0],
    { ...base, favorite: true, name: "", notify: false });
  const state = position => ({ assetPositions: [{ position }] });
  const positions = parsePositions({
    "": state({ coin: "ETH", szi: "2", positionValue: "1900", unrealizedPnl: "-15" }),
    xyz: state({ coin: "xyz:NVDA", szi: "-1", positionValue: "170", unrealizedPnl: "-20" }),
    cash: state({ coin: "cash:NVDA", szi: "-1", positionValue: "175" }),
  });
  assert.deepEqual(filterPositions(positions, { query: "NVDA", side: "short", sort: "loss" }).map(row => row.coin),
    ["xyz:NVDA", "cash:NVDA"]);
  assert.deepEqual(filterPositions(positions, { side: "long" }).map(row => row.coin), ["ETH"]);
});

test("仓位价值支持升降序且缺失数据排在末尾", () => {
  const positions = parsePositions({ "": { assetPositions: [
    { position: { coin: "ETH", szi: "-2", positionValue: "-1900" } },
    { position: { coin: "BTC", szi: "1", positionValue: "200" } },
    { position: { coin: "SOL", szi: "1", positionValue: "30" } },
    { position: { coin: "HYPE", szi: "1" } },
  ] } });
  const coins = options => filterPositions(positions, options).map(row => row.coin);
  assert.deepEqual(coins(), ["ETH", "BTC", "SOL", "HYPE"]);
  assert.deepEqual(coins({ sort: "notional-asc" }), ["SOL", "BTC", "ETH", "HYPE"]);
  assert.deepEqual(coins({ sort: "notional-asc", side: "long" }), ["SOL", "BTC", "HYPE"]);
});

test("交易行为统计按仓位变动、成交额和有盈亏的减平仓计算", () => {
  const time = Date.parse("2026-11-18T16:10:00Z");
  const stats = tradingActivity([
    { action: "open", time, value: 100, coin: "BTC" },
    { action: "reduce", time, value: 50, closedPnl: 6, coin: "BTC" },
    { action: "close", time: time + 7200000, value: 300, closedPnl: -2, coin: "xyz:NVDA" },
    { action: "close", time: time + 7200000, value: 50, closedPnl: null, coin: "ETH" },
  ]);
  assert.deepEqual(stats, {
    actions: { open: 1, add: 0, reduce: 1, close: 2, reverse: 0 },
    volume: 500, realized: 4, profitable: 1, known: 2, peakHours: [0, 2],
    topCoins: [["xyz:NVDA", 300], ["BTC", 150], ["ETH", 50]],
  });
});

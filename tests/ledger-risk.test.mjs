import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { day, cleanProfile } from "../dist/server/analytics.js";
import { evaluateRisk, planAdvancedRisk, privatePush } from "../dist/server/advanced-risk.js";
import { decimal, decimalText, periodStart, positionHistory, summarizeAccount } from "../dist/server/accounting.js";
import { marketRecord, recordMarketRows } from "../dist/server/market-ledger.js";
import { syncHistory } from "../dist/server/ledger-sync.js";
import { readInbox } from "../dist/server/inbox.js";
import worker from "../dist/server/index.js";

const wallet = "0x" + "d".repeat(40);
const now = Date.parse("2026-11-19T06:00:00Z");
const minute = 60_000;
const fill = (tid, time, before, size, side, closedPnl = "0", options) => ({
  tid, time, coin: "BTC", px: "2000", sz: size, side, startPosition: before, closedPnl,
  fee: "0.3", builderFee: "0.2", feeToken: "USDC", ...options,
});
const funding = (time, usdc) => ({ time, coin: "BTC", usdc });

function setup(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0000_watchlist", "0001_alert_receipts", "0002_trade_alert_buffer", "0003_wallet_history", "0004_alert_details"]) {
    sqlite.exec(readFileSync(new URL("../drizzle/" + file + ".sql", import.meta.url), "utf8"));
  }
  sqlite.exec("ALTER TABLE alerts ADD COLUMN title TEXT");
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bind = (...params) => ({
        first: () => statement.get(...params),
        all: () => ({ results: statement.all(...params) }),
        run: () => ({ meta: statement.run(...params) }),
      });
      return { ...bind(), bind };
    },
    batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const output = statements.map(statement => statement.run());
        sqlite.exec("COMMIT");
        return output;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sqlite, DB };
}

test("账本以 UTC+8 切分区间，精确处理小数、返佣、Builder 费用和本金流水", () => {
  assert.equal(periodStart("today", now), Date.parse("2026-11-18T16:00:00Z"));
  assert.equal(periodStart("week", now), Date.parse("2026-11-15T16:00:00Z"));
  assert.equal(periodStart("month", now), Date.parse("2026-10-31T16:00:00Z"));
  assert.equal(decimalText(decimal("1e-17")), "0.00000000000000001");
  assert.equal(decimal("NaN"), null);
  const summary = summarizeAccount({
    fills: [fill(1, now, "0", "1", "B"), fill(2, now, "1", "1", "A", "12.50", { fee: "-0.05", builderFee: undefined })],
    funding: [funding(now, "-0.15"), funding(now, "0.01")],
    cash: [{ delta: { type: "deposit", usdc: "700" } }, { delta: { type: "withdraw", usdc: "30" } },
      { delta: { type: "accountClassTransfer", usdc: "335" } }],
  });
  assert.equal(summary.realized, "12.5");
  assert.equal(summary.notional, "4000");
  assert.deepEqual(summary.fees, { USDC: "0.05" });
  assert.deepEqual(summary.builderFees, { USDC: "0.2" });
  assert.deepEqual(summary.fundingIncome, { USDC: "0.01" });
  assert.deepEqual(summary.fundingPaid, { USDC: "0.15" });
  assert.deepEqual(summary.cash, { deposit: { USDC: "700" }, withdraw: { USDC: "30" }, transfer: { USDC: "335" }, other: {} });
});

test("完整仓位计算开加减平和净收益，反手费用及不完整仓位正确降级", () => {
  const positions = [
    fill(1, now, "0", "1", "B"), fill(2, now + 1, "1", "0.5", "B"),
    fill(3, now + 3, "1.5", "0.2", "A", "1.2"), fill(4, now + 6, "1.3", "1.3", "A", "12"),
  ];
  const [trade] = positionHistory(positions, [funding(now + 2, "0.05")], () => true);
  assert.equal(trade.complete, true);
  assert.equal(trade.realized, "13.2");
  assert.equal(trade.net, "12.05");
  assert.deepEqual(trade.steps.map(row => row.action), ["open", "add", "reduce", "close"]);
  const [partial] = positionHistory(positions.slice(1), [], () => true);
  assert.equal(partial.net, null);
  assert.equal(partial.start, null);
  const [notCovered] = positionHistory(positions, [], () => false);
  assert.equal(notCovered.complete, false);
  const reversal = positionHistory([positions[0], fill(5, now + 1, "1", "2", "A", "50"),
    fill(6, now + 2, "-1", "1", "B", "20")], [], () => true);
  assert.deepEqual(reversal.map(row => row.side), ["short", "long"]);
  assert.equal(reversal[1].realized, "50");
  assert.equal(reversal[1].net, null);
  assert.deepEqual(reversal[0].steps.map(row => row.action), ["reverseOpen", "close"]);
});

test("成交、资金费、订单和资金流水对实时重放与 REST 记录去重", async t => {
  const { sqlite, DB } = setup(t);
  const seed = fill(42, now, "1", "1", "A", "20");
  await recordMarketRows(DB, wallet, "fill", [seed, { ...seed, sz: 1 }]);
  await recordMarketRows(DB, wallet, "funding", [funding(now + 17, "-0.01"), { time: now, delta: funding(now, "-0.01") }]);
  const deposit = { time: now, hash: "a", delta: { type: "deposit", usdc: "500.000" } };
  await recordMarketRows(DB, wallet, "ledger", [deposit, { ...deposit, delta: { ...deposit.delta, usdc: 500 } }]);
  const order = { order: { coin: "xyz:NVDA", oid: 8 }, statusTimestamp: now, status: "open" };
  await recordMarketRows(DB, wallet, "order", [order, order, { ...order, status: "filled" }]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM market_records").get().n, 5);
  assert.notEqual(marketRecord("ledger", deposit).id, marketRecord("ledger", { ...deposit, hash: "b" }).id);
});

test("同步遇到分页或断线保留覆盖边界，恢复后补齐并可优先回填", async t => {
  const { sqlite, DB } = setup(t);
  const address = "0x" + "f".repeat(40);
  let response = "truncated";
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_uri, opts) => {
    const params = JSON.parse(opts.body);
    calls.push(params);
    if (response === "truncated") return Response.json(Array.from({ length: 500 }, (_, i) => fill(i, params.startTime + i, "0", "1", "B")));
    if (response === "offline") throw Error("offline");
    return Response.json([]);
  });
  await syncHistory(DB, address, "fill", now);
  const state = () => sqlite.prepare("SELECT * FROM market_coverage WHERE wallet = ?").get(address);
  assert.equal(state().status, "limited");
  assert.equal(state().since, null);
  assert.equal(state().span, day / 2);
  response = "ok";
  await syncHistory(DB, address, "fill", now + minute);
  assert.equal(state().status, "ready");
  assert.equal(state().through, now + minute);
  const first = state().since;
  response = "offline";
  await syncHistory(DB, address, "fill", now + 2 * minute, true);
  assert.equal(state().status, "unavailable");
  assert.equal(state().since, first);
  response = "ok";
  await syncHistory(DB, address, "fill", now + 5 * minute, true);
  assert.equal(calls.at(-1).endTime, first - 1);
  assert.equal(state().since, first - day);
  await syncHistory(DB, address, "fill", now + 6 * minute);
  assert.equal(state().through, now + 6 * minute);
});

test("账本及风险提醒详情按账户授权，游标分页不重复", async t => {
  const { sqlite, DB } = setup(t);
  sqlite.prepare("INSERT INTO profiles VALUES (?, ?, ?)").run("alpha", JSON.stringify({ wallets: [{ address: wallet }] }), 1);
  await recordMarketRows(DB, wallet, "fill", Array.from({ length: 35 }, (_, i) => fill(i + 1, Date.now(), "0", "1", "B")));
  const call = (user, path, claimed = user) => worker.fetch(new Request("https://test.invalid" + path, {
    headers: { "oai-authenticated-user-id": user, "x-hyper-account": claimed },
  }), { DB });
  const path = "/api/ledger?" + new URLSearchParams({ wallet, view: "fill" });
  assert.equal((await call("alpha", path, "beta")).status, 401);
  assert.equal((await call("beta", path)).status, 404);
  const head = await (await call("alpha", path)).json();
  const tail = await (await call("alpha", path + "&" + new URLSearchParams({ before: head.next.time, id: head.next.id }))).json();
  assert.equal(head.rows.length, 30);
  assert.equal(tail.rows.length, 5);
  assert.equal(new Set([...head.rows, ...tail.rows].map(row => row.id)).size, 35);
  assert.equal(tail.next, null);
  await DB.batch(await planAdvancedRisk(DB, "alpha", { address: wallet }, { positionLoss: 40, cooldown: 15 }, now,
    [{ coin: "BTC", pnl: -120 }], null, null));
  await DB.batch(await planAdvancedRisk(DB, "alpha", { address: wallet }, { positionLoss: 40, cooldown: 15 }, now,
    [{ coin: "BTC", pnl: -120 }], null, null));
  const filters = { kind: "risk", unread: false };
  const visible = await readInbox(DB, "alpha", filters);
  assert.equal(visible.items.length, 1);
  assert.equal(visible.items[0].details.level, "critical");
  assert.equal(visible.items[0].details.path, "/?wallet=" + wallet + "&position=BTC");
  assert.match(visible.items[0].body, /UTC\+8.*\nBTC .*\$120/);
  assert.equal((await readInbox(DB, "beta", filters)).items.length, 0);
});

test("分级风险判断、冷却、缺失数据、行情中断及锁屏隐私", async () => {
  const rule = cleanProfile({ rules: { advancedRisk: { marginUsage: 30, positionLoss: 50,
    positionGainRate: 20, dailyLoss: 70, positionChange: 1, dataOutage: 5 } } }).rules.advancedRisk;
  assert.equal(rule.cooldown, 15);
  const at = periodStart("today", now);
  const history = { day: { equity: [[at, 800], [now, 1000]], pnl: [[at, 0], [now, -80]] } };
  const first = evaluateRisk(rule, null, now, [{ coin: "BTC", pnl: -70, margin: 350, returnOnEquity: 0.3 }],
    history, [now, 1000]);
  assert.deepEqual(first.notices.map(row => row.level).sort(), ["info", "warning", "warning", "warning"]);
  const next = evaluateRisk(rule, first.state, now + minute, [{ coin: "BTC", pnl: -105, margin: 350, returnOnEquity: 0.3 },
    { coin: "xyz:NVDA", pnl: 0, margin: 0, returnOnEquity: 0 }], history, [now, 1000]);
  assert.deepEqual(next.notices.map(row => row.key), ["count", "loss:BTC"]);
  assert.equal(next.notices[1].level, "critical");
  const failure = evaluateRisk(rule, next.state, now + 7 * minute, null, null, null);
  assert.deepEqual(failure.notices.map(row => row.key), ["outage"]);
  assert.equal(failure.state.active["loss:BTC"].level, "critical");
  const payload = { title: "BTC 亏损", body: "$120", tag: "risk:" + wallet, path: "/?wallet=" + wallet };
  const discreet = await privatePush(payload, true);
  assert.doesNotMatch(JSON.stringify(discreet), /BTC|120|0x/);
  assert.equal(discreet.path, "/#alerts");
  assert.equal((await privatePush(payload, true)).tag, discreet.tag);
  assert.equal(await privatePush(payload, false), payload);
});

test("今日快照接口只返回当前账户保存的钱包和 UTC+8 相关样本", async t => {
  const { sqlite, DB } = setup(t);
  t.mock.method(Date, "now", () => now);
  const midnight = periodStart("today", now);
  const insert = sqlite.prepare("INSERT INTO wallet_equity_history VALUES (?,?,?,?)");
  insert.run(wallet, midnight - 31 * minute, "10", "20");
  insert.run(wallet, midnight - 15 * minute, "123", null);
  insert.run(wallet, midnight, "124", "19");
  insert.run(wallet, now + 1, "500", "800");
  sqlite.prepare("INSERT INTO profiles VALUES (?, ?, ?)").run("alpha", JSON.stringify({ wallets: [{ address: wallet }] }), 1);
  const route = "https://test.invalid/api/equity-snapshots?wallet=" + wallet;
  const call = account => worker.fetch(new Request(route, {
    headers: { "oai-authenticated-user-id": account, "x-hyper-account": account },
  }), { DB });
  assert.equal((await call("beta")).status, 404);
  assert.deepEqual(await (await call("alpha")).json(), {
    equity: [[midnight - 15 * minute, 123], [midnight, 124]], pnl: [[midnight, 19]],
  });
});

test("概览优先使用已覆盖今日的成交，与近 24 小时事件的覆盖分别判断", async t => {
  const { sqlite, DB } = setup(t);
  t.mock.method(Date, "now", () => now);
  const midnight = periodStart("today", now);
  const coverage = sqlite.prepare("INSERT INTO market_coverage VALUES (?,?,?,?,?,?,?)");
  sqlite.prepare("INSERT INTO profiles VALUES (?, ?, ?)").run("alpha", JSON.stringify({ wallets: [{ address: wallet }] }), 1);
  const until = now - 30_000;
  coverage.run(wallet, "fill", midnight, until, now, "ready", 86_400_000);
  coverage.run(wallet, "ledger", now - day, until, now, "ready", 86_400_000);
  await recordMarketRows(DB, wallet, "fill", [
    fill(1, midnight - 1000, "1", "1", "A", "999"),
    fill(2, midnight + 1000, "1", "1", "A", "20.5"),
    fill(3, midnight + 2000, "1", "1", "A", "25", { coin: "@1" }),
    fill(4, now - 1000, "1", "1", "A", "111"),
  ]);
  await recordMarketRows(DB, wallet, "ledger", [{ time: midnight + 2000, hash: "fixture", delta: { type: "deposit", usdc: "123" } }]);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_, init) => {
    requests.push(JSON.parse(init.body).type);
    throw Error("Upstream timed out");
  });
  const call = async account => {
    const route = "https://test.invalid/api/overview-activity?wallet=" + wallet;
    const response = await worker.fetch(new Request(route, {
      headers: { "oai-authenticated-user-id": account, "x-hyper-account": account },
    }), { DB });
    return response.json();
  };
  const saved = await call("alpha");
  assert.equal(saved.realized, 20.5);
  assert.equal(saved.realizedAsOf, until);
  assert.equal(saved.fillsState, "ready");
  assert.equal(saved.tradeEventsState, "incomplete");
  assert.equal(saved.ledgerState, "ready");
  assert.ok(saved.events.some(event => event.type === "deposit"));
  assert.deepEqual(requests, []);
  const unsaved = await call("beta");
  assert.equal(unsaved.fillsState, "unavailable");
  assert.equal(unsaved.realized, null);
  assert.equal(unsaved.events.length, 0);
  assert.deepEqual(requests.sort(), ["userFillsByTime", "userNonFundingLedgerUpdates"]);

  const setThrough = sqlite.prepare("UPDATE market_coverage SET through=? WHERE wallet=? AND kind='fill'");
  setThrough.run(now - 180_000, wallet);
  const fallback = await call("alpha");
  assert.equal(fallback.realized, 20.5);
  assert.equal(fallback.realizedAsOf, now - 180_000);
  assert.equal(fallback.tradeEventsState, "unavailable");

  sqlite.prepare("UPDATE market_coverage SET since=?, through=? WHERE wallet=? AND kind='fill'")
    .run(midnight - 10_000, midnight - 1000, wallet);
  const yesterday = await call("alpha");
  assert.equal(yesterday.fillsState, "unavailable");
  assert.equal(yesterday.realized, null);
});

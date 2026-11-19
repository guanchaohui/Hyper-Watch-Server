import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { cleanEquityChangeAlert, cleanProfile } from "../dist/server/analytics.js";
import { checkAlerts, equityAlertLevels, queueAlertDelivery } from "../dist/server/alerts.js";
import { readAlertHealth, readPushHealth, savePushHealth } from "../dist/server/alert-health.js";

function alertStore() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../drizzle/0002_trade_alert_buffer.sql", import.meta.url), "utf8"));
  sqlite.exec(
    "CREATE TABLE profiles(user_id TEXT PRIMARY KEY,settings TEXT);" +
    "CREATE TABLE alert_status(user_id TEXT,target TEXT,cursor INTEGER,breached TEXT,PRIMARY KEY(user_id,target));" +
    "CREATE TABLE task_leases(name TEXT PRIMARY KEY,holder TEXT,lease_until INTEGER);" +
    "CREATE TABLE push_devices(user_id TEXT,endpoint TEXT,subscription TEXT,PRIMARY KEY(user_id,endpoint));" +
    "CREATE TABLE alerts(user_id TEXT,event_id TEXT,title TEXT,body TEXT,created_at INTEGER,PRIMARY KEY(user_id,event_id));" +
    "CREATE TABLE transmissions(user_id TEXT,event_id TEXT,endpoint TEXT,PRIMARY KEY(user_id,event_id,endpoint));",
  );
  sqlite.exec(readFileSync(new URL("../drizzle/0004_alert_details.sql", import.meta.url), "utf8"));
  const db = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bind = (...params) => ({
        first: () => statement.get(...params),
        all: () => ({ results: statement.all(...params) }),
        run: () => ({ meta: statement.run(...params) }),
      });
      return { ...bind(), bind };
    },
    async batch(statements) { for (const statement of statements) statement.run(); },
  };
  return { sqlite, db };
}

test("旧的重复下跌规则优先保留保护线，权益推送包含 UTC+8 今日幅度和入金出金", async () => {
  const { sqlite, db } = alertStore();
  const beforeFetch = globalThis.fetch;
  const beforeNow = Date.now;
  const midnight = Date.parse("2026-11-17T16:00:00Z");
  let now = midnight + 60 * 60_000;
  let equity = 100;
  const address = "0x" + "a".repeat(40);
  Date.now = () => now;
  globalThis.fetch = async (_, options) => {
    const data = JSON.parse(options.body);
    assert.equal(data.user, address);
    if (data.type === "userNonFundingLedgerUpdates") {
      assert.equal(data.startTime, midnight);
      return Response.json([
        { time: midnight + 1000, delta: { type: "deposit", usdc: "100" } },
        { time: midnight + 2000, delta: { type: "withdraw", usdc: "25" } },
        { time: midnight + 3000, delta: { type: "internalTransfer", usdc: "5000" } },
      ]);
    }
    assert.equal(data.type, "portfolio");
    return Response.json([["day", { accountValueHistory: [[midnight, 2500], [now, equity]], pnlHistory: [] }]]);
  };
  try {
    const rule = cleanEquityChangeAlert({ up: 5, down: 5 });
    const scan = async value => {
      now += 60_000;
      equity = value;
      const result = await checkAlerts({ DB: db });
      assert.equal(result.failures, 0);
    };
    const setProfile = rules => sqlite.prepare("INSERT OR REPLACE INTO profiles VALUES (?, ?)").run("test", JSON.stringify({
      wallets: [{ address, role: "mine" }], rules,
    }));
    setProfile({ equityChangeAlert: rule });
    assert.equal((await equityAlertLevels(db, "test")).change.baseline, null);
    assert.deepEqual(await equityAlertLevels(db, "other"), { hasWallet: false });
    await scan(2233.24);
    setProfile({ equityChangeAlert: rule, equityMode: "percent", equity: 10 });
    await scan(2233.24);
    const levels = await equityAlertLevels(db, "test");
    assert.equal(levels.change.baseline, 2233.24);
    assert.equal(levels.change.down, null);
    assert.equal(levels.change.up.toFixed(2), "2344.90");
    assert.equal(levels.floor.peak, 2233.24);
    assert.equal(levels.floor.down.toFixed(2), "2009.92");
    await scan(2020);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM alerts").get().count, 0);
    await scan(2009.90);
    await scan(2009.90);
    await scan(2233.24 * 1.05);
    const items = sqlite.prepare("SELECT title, body FROM alerts ORDER BY created_at").all();
    assert.equal(items.length, 2);
    assert.equal(items[0].title, "📉 账户权益 · 今日 -19.60%");
    assert.match(items[0].body, /UTC\+8 零点起 -\$490\.10，当前 \$2,009\.90/);
    assert.match(items[0].body, /较最高点回落 10\.00%/);
    assert.doesNotMatch(items[0].body, /较上次基准下跌/);
    assert.match(items[0].body, /今日入金 \+\$100\.00 · 今日出金 -\$25\.00/);
    assert.match(items[1].body, /较上次基准上涨 5\.00%/);
    assert.equal((await equityAlertLevels(db, "test")).change.baseline, 2233.24 * 1.05);
    assert.deepEqual(await readAlertHealth(db, "test"), { time: now, checked: 1, failures: 0 });
    assert.equal(await readAlertHealth(db, "other"), null);
    await savePushHealth(db, "test", "https://example.com/test-device", "sent", true);
    assert.deepEqual(await readPushHealth(db, "test", "https://example.com/test-device"), { time: now, state: "sent", test: true });
    assert.equal(await readPushHealth(db, "other", "https://example.com/test-device"), null);
    assert.equal(cleanEquityChangeAlert({ up: "", down: 5 }).up, null);
    assert.equal(cleanEquityChangeAlert({}), null);
  } finally {
    globalThis.fetch = beforeFetch;
    Date.now = beforeNow;
    sqlite.close();
  }
});

test("固定金额和上次基准跌幅只能有一条，空的保护线可以继续追踪跌幅", () => {
  const equityChangeAlert = { up: 4, down: 5 };
  const fixed = cleanProfile({ rules: { equityChangeAlert, equityMode: "amount", equity: 2000 } }).rules;
  assert.equal(fixed.equity, 2000);
  assert.deepEqual(fixed.equityChangeAlert, { up: 4, down: null, id: null });
  const noFloor = cleanProfile({ rules: { equityChangeAlert, equityMode: "percent", equity: 101 } }).rules;
  assert.equal(noFloor.equity, null);
  assert.deepEqual(noFloor.equityChangeAlert, { up: 4, down: 5, id: null });
});

test("短时权益波动等待完整窗口、合并同轮权益提醒，杠杆计算计入 HIP-3 空仓", async () => {
  const { sqlite, db } = alertStore();
  const beforeFetch = globalThis.fetch;
  const beforeNow = Date.now;
  const midnight = Date.parse("2026-11-18T16:00:00Z");
  const address = "0x" + "b".repeat(40);
  let now = midnight;
  let equity;
  let stale = false;
  Date.now = () => now;
  globalThis.fetch = async (_, options) => {
    const data = JSON.parse(options.body);
    if (data.type === "perpDexs") return Response.json([null, { name: "xyz" }]);
    assert.equal(data.user, address);
    if (data.type === "userNonFundingLedgerUpdates") return Response.json([]);
    if (data.type === "portfolio") {
      return Response.json([["day", { accountValueHistory: [[midnight, 1100], [stale ? now - 180_000 : now, equity]] }]]);
    }
    assert.equal(data.type, "clearinghouseState");
    const position = data.dex ? { coin: "xyz:NVDA", szi: "-10", positionValue: "1300" } :
      { coin: "BTC", szi: "0.02", positionValue: "1700" };
    return Response.json({ assetPositions: [{ position }] });
  };
  const scan = async value => {
    now += 60_000;
    equity = value;
    assert.equal((await checkAlerts({ DB: db })).failures, 0);
  };
  const alerts = () => sqlite.prepare("SELECT title, body FROM alerts ORDER BY created_at, title").all();
  sqlite.prepare("INSERT INTO profiles VALUES (?, ?)").run("risk", JSON.stringify({
    wallets: [{ address, role: "mine" }], rules: {
      equityChangeAlert: { down: 5 }, equityVolatility: { minutes: 5, threshold: 3 }, leverageAlert: 3,
    },
  }));
  try {
    for (let i = 0; i < 5; i++) await scan(1000);
    assert.deepEqual(alerts(), []);
    await scan(950);
    const first = alerts();
    assert.equal(first.length, 2);
    const volatility = first.find(item => item.title.includes("权益波动"));
    assert.equal(volatility.title, "📉 权益波动 · 5 分钟 -5.00%");
    assert.match(volatility.body, /今日 -13\.64%（-\$150\.00）/);
    assert.match(volatility.body, /触发：较上次基准下跌 5\.00%/);
    const leverage = first.find(item => item.title.includes("总杠杆率"));
    assert.equal(leverage.title, "⚠️ 总杠杆率 · 3.16×");
    assert.match(leverage.body, /名义仓位 \$3,000\.00/);
    await scan(940);
    assert.equal(alerts().length, 2);
    await scan(1000);
    await scan(1040);
    assert.equal(alerts().filter(item => item.title === "📈 权益波动 · 5 分钟 +4.00%").length, 1);
    await scan(970);
    assert.equal(alerts().filter(item => item.title.includes("总杠杆率")).length, 2);
    assert.equal(alerts().filter(item => item.title === "📉 权益波动 · 5 分钟 -3.00%").length, 1);
    const count = alerts().length;
    stale = true;
    await scan(960);
    assert.equal(alerts().length, count);
  } finally {
    globalThis.fetch = beforeFetch;
    Date.now = beforeNow;
    sqlite.close();
  }
});

test("同一轮仓位风险合并后，每台设备只提交一次", async () => {
  const { sqlite, db } = alertStore();
  const beforeFetch = globalThis.fetch;
  const beforeNow = Date.now;
  const address = "0x" + "c".repeat(40);
  const endpoint = "https://fcm.googleapis.com/fcm/send/test-only";
  let now = Date.parse("2026-11-19T16:00:00Z");
  Date.now = () => now;
  let submissions = 0;
  const deviceKey = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const subscription = {
    endpoint, since: now - 1000, keys: {
      p256dh: Buffer.from(await crypto.subtle.exportKey("raw", deviceKey.publicKey)).toString("base64url"),
      auth: Buffer.alloc(16, 1).toString("base64url"),
    },
  };
  const env = {
    DB: db, PUBLIC_ORIGIN: "https://test.example",
    VAPID_PRIVATE: JSON.stringify(await crypto.subtle.exportKey("jwk", vapid.privateKey)),
    VAPID_PUBLIC: Buffer.from(await crypto.subtle.exportKey("raw", vapid.publicKey)).toString("base64url"),
  };
  globalThis.fetch = async (url, options) => {
    if (String(url) === endpoint) {
      submissions++;
      assert.equal(options.headers.Topic.length, 32);
      return new Response(null, { status: 201 });
    }
    assert.equal(JSON.parse(options.body).type, "clearinghouseState");
    return Response.json({ assetPositions: [{ position: {
      coin: "BTC", szi: "1", positionValue: "100", unrealizedPnl: "-40", liquidationPx: "98",
    } }, { position: {
      coin: "ETH", szi: "-1", positionValue: "100", unrealizedPnl: "0", liquidationPx: null,
    } }] });
  };
  try {
    sqlite.prepare("INSERT INTO profiles VALUES (?, ?)").run("sample", JSON.stringify({
      wallets: [{ address, role: "mine", name: "样例钱包" }], rules: { loss: 30, gap: 3 },
    }));
    sqlite.prepare("INSERT INTO push_devices VALUES (?, ?, ?)").run("sample", endpoint, JSON.stringify(subscription));
    assert.equal((await checkAlerts(env)).sent, 1);
    await Promise.all([queueAlertDelivery(env, "sample"), queueAlertDelivery(env, "sample")]);
    now += 60000;
    assert.equal((await checkAlerts(env)).sent, 0);
    assert.equal(submissions, 1);
    const alerts = sqlite.prepare("SELECT title, body FROM alerts").all();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].title, "仓位风险 · 样例钱包");
    assert.match(alerts[0].body, /合约净浮亏达到 \$40\.00\nBTC 距离强平还剩 2\.00%/);
    assert.doesNotMatch(alerts[0].body, /ETH/);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM transmissions").get().count, 1);
  } finally {
    globalThis.fetch = beforeFetch;
    Date.now = beforeNow;
    sqlite.close();
  }
});

test("数据中断以采集完成时间判断，接受请求发出后的权益样本", async t => {
  const { sqlite, db } = alertStore();
  t.after(() => sqlite.close());
  const address = "0x" + "e".repeat(40);
  const minute = 60_000;
  let now = Date.parse("2026-11-20T07:00:00Z");
  let stale = false;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (_, options) => {
    const { type } = JSON.parse(options.body);
    if (type === "perpDexs") return Response.json([null]);
    if (type === "clearinghouseState") return Response.json({ assetPositions: [] });
    assert.equal(type, "portfolio");
    now += 1_800;
    const sampledAt = now - (stale ? 3 * minute : 300);
    return Response.json([["day", { accountValueHistory: [[sampledAt, "1000"]] }]]);
  });
  sqlite.prepare("INSERT INTO profiles VALUES (?, ?)").run("outage", JSON.stringify({
    wallets: [{ address, role: "mine" }], rules: { advancedRisk: { dataOutage: 15 } },
  }));
  const state = () => JSON.parse(sqlite.prepare("SELECT breached FROM alert_status WHERE user_id=? AND target=?")
    .get("outage", "advanced-risk:" + address).breached);
  const scan = async () => assert.equal((await checkAlerts({ DB: db })).failures, 0);
  const notices = () => sqlite.prepare("SELECT body FROM alerts").all();

  await scan();
  assert.equal(state().healthyAt, now);
  now += 30 * minute;
  await scan();
  assert.equal(state().healthyAt, now);
  assert.deepEqual(notices(), []);

  stale = true;
  now += 16 * minute;
  await scan();
  assert.match(notices()[0].body, /数据已中断 16 分钟（阈值 15 分钟）/);
  const lastHealthy = state().healthyAt;
  now += minute;
  await scan();
  assert.equal(state().healthyAt, lastHealthy);
  assert.equal(notices().length, 1);

  stale = false;
  now += minute;
  await scan();
  assert.equal(state().healthyAt, now);
  assert.equal(state().active.outage.breached, false);
});

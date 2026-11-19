import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanProfile, notificationFieldLabels, positionChanges } from "../dist/server/analytics.js";
import { formatFillNotification, formatNotificationPreview } from "../dist/server/notification-format.js";
import { recordFillAlerts } from "../dist/server/alerts.js";

const formatFull = (wallet, change) => formatFillNotification(wallet, change, Object.keys(notificationFieldLabels), "quantity");

const wallet = { address: "0x" + "a".repeat(40), name: "币安无私钥钱包" };
const fill = { coin: "xyz:NVDA", tid: 123, time: 1700000000000, px: "160.05", closedPnl: "2.75" };

const scenarios = [
  { label: "开多", marker: "🟢", dir: "Open Long", side: "B", start: "0", size: "0.761", end: "0.761" },
  { label: "加多", marker: "🟢", dir: "Open Long", side: "B", start: "2.431", size: "0.761", end: "3.192" },
  { label: "减多", marker: "🟢", dir: "Close Long", side: "A", start: "2.431", size: "0.761", end: "1.67" },
  { label: "平多", marker: "🟢", dir: "Close Long", side: "A", start: "0.761", size: "0.761", end: "0" },
  { label: "开空", marker: "🔴", dir: "Open Short", side: "A", start: "0", size: "0.761", end: "-0.761" },
  { label: "加空", marker: "🔴", dir: "Open Short", side: "A", start: "-2.431", size: "0.761", end: "-3.192" },
  { label: "减空", marker: "🔴", dir: "Close Short", side: "B", start: "-2.431", size: "0.761", end: "-1.67" },
  { label: "平空", marker: "🔴", dir: "Close Short", side: "B", start: "-0.761", size: "0.761", end: "0" },
];

for (const { label, marker, dir, side, start, size, end } of scenarios) {
  test(label, () => {
    const [change] = positionChanges([{ ...fill, dir, side, startPosition: start, sz: size }], false);
    const notification = formatFull(wallet, change);
    assert.equal(notification.title, marker + " NVDA · " + label);
    const lines = notification.body.split("\n");
    assert.deepEqual(lines.slice(0, 4), [
      "成交：0.761 张 @ $160.05",
      "仓位：" + start + " → " + end + " 张",
      "名义价值：$121.80",
      wallet.name,
    ]);
    assert.deepEqual(lines.slice(4), label.startsWith("减") || label.startsWith("平") ? ["已实现盈亏：+2.75"] : []);
  });
}

test("小额成交和低价资产保留非零信息，整数价格不补小数", () => {
  const small = formatFull(wallet, {
    coin: "BTC", action: "open", start: 0, end: 0.00001, size: 0.00001, price: 0.00000012345,
  });
  assert.match(small.body, /成交：<0\.001 张 @ \$0\.00000012345/);
  assert.match(small.body, /名义价值：<\$0\.01/);
  const whole = formatFull(wallet, {
    coin: "BTC", action: "open", start: 0, end: 1, size: 1, price: 65000, value: 65000,
  });
  assert.match(whole.body, /成交：1 张 @ \$65,000\n/);
  assert.match(whole.body, /名义价值：\$65,000\.00/);
});

test("缺失字段、钱包备注回退和反手盈亏", () => {
  const missing = formatFull({}, { action: "close", start: -1, end: 0 });
  assert.doesNotMatch(missing.title + missing.body, /undefined|null|NaN/);
  assert.match(missing.body, /名义价值：—\n未命名钱包\n已实现盈亏：—/);
  const reverse = formatFull({ address: wallet.address }, {
    coin: "ETH", action: "reverse", start: -1, end: 0.5, size: 1.5, price: 2000,
    value: 3000, closedPnl: -0.25,
  });
  assert.equal(reverse.title, "🟢 ETH · 反手做多");
  assert.match(reverse.body, /仓位：-1 → 0\.5 张\n名义价值：\$3,000\.00\n0xaaaa…aaaa\n已实现盈亏：-0\.25/);
});

test("统一格式写入提醒，原成交 ID 与去重保持有效", async () => {
  const inserted = new Map();
  const db = {
    prepare(sql) {
      assert.match(sql, /INSERT OR IGNORE INTO alerts/);
      return { bind: (...args) => args };
    },
    async batch(rows) {
      return rows.map(([user, id, title, body]) => {
        const key = user + ":" + id;
        if (inserted.has(key)) return { meta: { changes: 0 } };
        inserted.set(key, { title, body });
        return { meta: { changes: 1 } };
      });
    },
  };
  const rows = [{ ...fill, dir: "Open Long", side: "B", startPosition: "2.431", sz: "0.761" }];
  assert.equal(await recordFillAlerts(db, "test", wallet, { actions: ["close"] }, rows), false);
  const individual = { ...wallet, tradeCooldown: 0 };
  const rules = { actions: ["add"], notificationPositionUnit: "quantity" };
  assert.equal(await recordFillAlerts(db, "test", individual, rules, rows), true);
  assert.equal(await recordFillAlerts(db, "test", individual, rules, rows), false);
  const notice = inserted.get("test:fill:" + wallet.address + ":123");
  assert.equal(notice.title, "🟢 NVDA · 加多");
  assert.match(notice.body, /仓位：2\.431 → 3\.192 张/);
});

test("精简默认、单独隐藏钱包和仅标题", () => {
  const change = { coin: "NVDA", action: "reduce", start: 3.192, end: 2.431, size: 0.761, price: 160.05, closedPnl: -25.5 };
  const rules = cleanProfile({}).rules;
  assert.deepEqual(rules.notificationFields, ["trade", "position", "pnl"]);
  assert.equal(rules.notificationPositionUnit, "usd");
  assert.equal(formatFillNotification(wallet, change, rules.notificationFields).body,
    "成交：0.761 张 @ $160.05\n仓位价值：$510.88 → $389.08\n已实现盈亏：-25.50");
  assert.equal(formatFillNotification(wallet, change, ["wallet", "invalid", "wallet"]).body, wallet.name);
  assert.deepEqual(cleanProfile({ rules: { notificationFields: [] } }).rules.notificationFields, []);
  assert.equal(formatFillNotification(wallet, change, []).body, "");
});

test("仓位美元显示保留反手方向、平仓零值和小额精度", () => {
  const line = (start, end, price) => formatFillNotification(wallet, { action: "reverse", start, end, price }, ["position"]).body;
  assert.equal(line(-1, 0.5, 2000), "仓位价值：空 $2,000.00 → 多 $1,000.00");
  assert.equal(line(-1.5, 0, 2000), "仓位价值：$3,000.00 → $0.00");
  assert.equal(line(0, 0.0001, 1), "仓位价值：$0.00 → <$0.01");
  assert.equal(line(null, 0, null), "仓位价值：— → $0.00");
  const unit = cleanProfile({ rules: { notificationPositionUnit: "quantity" } }).rules.notificationPositionUnit;
  assert.equal(unit, "quantity");
  assert.equal(formatNotificationPreview({ notificationFields: ["position"], notificationPositionUnit: unit }).body,
    "仓位：3.192 → 2.431 张");
  assert.equal(formatNotificationPreview({ notificationFields: ["position"] }).body, "仓位价值：$510.88 → $389.08");
});

test("测试推送可复用页面预览的交易字段、钱包名称和权益方向", () => {
  assert.equal(formatNotificationPreview({ type: "trade", name: "我的演示", notificationFields: ["wallet"] }).body, "我的演示");
  assert.equal(formatNotificationPreview({ type: "trade", notificationFields: [] }).body, "");
  assert.deepEqual(formatNotificationPreview({ type: "up", up: "12.5" }), {
    title: "📈 账户权益 · 今日 +14.80%", body: "UTC+8 零点起 +$145.00，当前 $1,125.00\n触发：较上次基准上涨 12.50%",
  });
  assert.deepEqual(formatNotificationPreview({ type: "down", down: "10" }), {
    title: "📉 账户权益 · 今日 -11.76%", body: "UTC+8 零点起 -$120.00，当前 $900.00\n触发：较上次基准下跌 10.00%",
  });
  assert.match(formatNotificationPreview({ type: "down", downsideMode: "percent", peakDrop: 8 }).body,
    /较最高点回落 8\.00%（提醒线 \$920\.00）/);
  assert.match(formatNotificationPreview({ type: "down", downsideMode: "amount", amount: 2200 }).body,
    /低于固定线 \$2,200\.00/);
  assert.deepEqual(formatNotificationPreview({ type: "volatility", volatility: { minutes: 10, threshold: 4 } }), {
    title: "📈 权益波动 · 10 分钟 +4.00%", body: "今日 +6.12%（+$60.00）\n当前权益 $1,040.00",
  });
  assert.deepEqual(formatNotificationPreview({ type: "leverage", leverage: 4 }), {
    title: "⚠️ 总杠杆率 · 4.25×", body: "超过提醒线 4×\n名义仓位 $4,250.00\n账户权益 $1,000.00",
  });
});

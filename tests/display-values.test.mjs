import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMoney } from "../dist/server/format-values.js";
import { renderLedger } from "../public/ledger-panel.js";
import { movedPositionOrder, orderPositions, positionKey } from "../public/position-order.js";

test("金额只显示两位，原币种与不足一分钱的金额可区分", () => {
  assert.equal(formatMoney("1.234567"), "$1.23");
  assert.equal(formatMoney("-0.0001234", { symbol: "", unit: "USDC" }), "-<0.01 USDC");
  assert.equal(formatMoney("0", { symbol: "", unit: "USDC" }), "0.00 USDC");
  assert.equal(formatMoney("0.0051"), "$0.01");
  assert.equal(formatMoney("0.001234"), "<$0.01");
  assert.equal(formatMoney("92.800012345"), "$92.80");
  assert.equal(formatMoney(""), "—");
  assert.equal(formatMoney(null), "—");
});

test("账本中的成交价格、手续费和 Builder 费按金额格式呈现", () => {
  let row;
  const ctx = {
    esc: String,
    table: (_, rows) => { row = rows[0]; return ""; },
    tip: String,
    ui: { amount: formatMoney, quantity: String, percent: String },
  };
  renderLedger("fill", { coverage: {}, rows: [{ time: 0, data: {
    coin: "BTC", side: "B", sz: "0.0001234", px: "7699.452", closedPnl: "-1.234567",
    fee: "0.789987", builderFee: "0.002113", feeToken: "USDC",
  } }] }, ctx);
  assert.equal(row[3], "0.0001234");
  assert.equal(row[4], "$7,699.45");
  assert.equal(row[5], "-$1.23");
  assert.equal(row[6], "0.79 USDC");
  assert.equal(row[7], "<0.01 USDC");
});

test("委托触发条件使用格式化后的触发价", () => {
  let row;
  renderLedger("open", { coverage: {}, rows: [{
    coin: "HYPE", side: "A", limitPx: "23.789851", sz: "2", isTrigger: true,
    triggerCondition: "Price below 23.789851", triggerPx: "23.789851",
  }] }, { esc: String, tip: String, table: (_, rows) => { row = rows[0]; return ""; },
    ui: { amount: formatMoney, quantity: String } });
  assert.equal(row[2], "$23.79");
  assert.equal(row[4], "Price below $23.79");
});

test("卡片排序按市场和币种区分，保留暂未持有的卡片顺序", () => {
  const rows = [{ dex: "xyz", coin: "BTC" }, { dex: "", coin: "BTC" }, { dex: "", coin: "ETH" }];
  const [a, b, c] = rows.map(positionKey);
  const absent = positionKey({ dex: "", coin: "SOL" });
  const changed = movedPositionOrder(rows, [absent], a, c, true);
  assert.deepEqual(changed, [b, c, a, absent]);
  assert.deepEqual(orderPositions(rows, changed), [rows[1], rows[2], rows[0]]);
  assert.equal(movedPositionOrder(rows, [], a, absent, false), null);
  assert.deepEqual(orderPositions(rows, []), rows);
});

test("总览布局保留自定义顺序并补入新增模块", async () => {
  const { overviewKeys, savedOverviewKeys } = await import("../public/overview-layout.js");
  const desktop = overviewKeys(false, false);
  const phone = overviewKeys(true, false);
  assert.equal(desktop.at(-1), "events");
  assert.ok(phone.indexOf("positions") < phone.indexOf("trend"));
  const order = savedOverviewKeys(desktop, ["positions", "trend", "positions", "retired"]);
  assert.deepEqual(order.slice(0, 2), ["positions", "trend"]);
  assert.equal(new Set(order).size, desktop.length);
  assert.deepEqual(savedOverviewKeys(phone, null), phone);
});

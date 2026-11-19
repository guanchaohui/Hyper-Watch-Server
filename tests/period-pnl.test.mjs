import assert from "node:assert/strict";
import { test } from "node:test";
import { day, periodPnl, portfolioPeriodPoints } from "../dist/server/analytics.js";

test("北京时间零点跨 UTC 日期，滚动 24 小时与近 7 天使用各自样本", () => {
  const now = Date.parse("2026-11-18T03:10:00Z");
  const midnight = Date.parse("2026-11-17T16:00:00Z");
  const dayStart = now - day;
  const weekStart = now - 7 * day;
  const make = points => ({ pnl: points, equity: points.map(([at]) => [at, 2000]) });
  const history = {
    day: make([[dayStart, 0], [midnight, 13], [now, 50]]),
    week: make([[weekStart, -50], [midnight, 13], [now, 50]]),
  };
  assert.deepEqual(periodPnl(history, "today", now), { start: midnight, pnl: 37, equity: 2000 });
  assert.equal(periodPnl(history, "day", now).pnl, 50);
  assert.equal(periodPnl(history, "week", now).pnl, 100);
  assert.deepEqual(portfolioPeriodPoints(history, "today", "pnl", now), [[midnight, 0], [now, 37]]);
  assert.deepEqual(portfolioPeriodPoints(history, "today", "equity", now), [[midnight, 2000], [now, 2000]]);
});
test("缺少零点后的样本时不显示昨日盈亏", () => {
  const midnight = Date.parse("2026-11-17T16:00:00Z");
  const now = midnight + 1000;
  const history = { day: { pnl: [[midnight - day, 3], [midnight - 1, 9]], equity: [] } };
  assert.equal(periodPnl(history, "today", now), null);
});

test("只用零点附近的两侧样本估算，过早的 21:46 不会成为今日基准", () => {
  const midnight = Date.parse("2026-11-18T16:00:00Z");
  const now = midnight + 60 * 60_000;
  const make = prior => ({ day: {
    pnl: [[prior, 20], [midnight + 10 * 60_000, 40], [now, 65]],
    equity: [[prior, 1000], [midnight + 10 * 60_000, 1020], [now, 1045]],
  } });
  const history = make(midnight - 10 * 60_000);
  assert.deepEqual(periodPnl(history, "today", now), { pnl: 35, start: midnight, equity: 1010, estimated: true });
  assert.deepEqual(portfolioPeriodPoints(history, "today", "pnl", now)[0], [midnight, 0]);
  const tooEarly = make(midnight - 134 * 60_000);
  assert.equal(periodPnl(tooEarly, "today", now), null);
  assert.deepEqual(portfolioPeriodPoints(tooEarly, "today", "equity", now), []);
});

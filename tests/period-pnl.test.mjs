import assert from "node:assert/strict";
import { test } from "node:test";
import { day, periodPnl, portfolioPeriodPoints, todayPortfolio } from "../dist/server/analytics.js";

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

test("展示今日的第一段可靠数据，零点缺失时用实际样本作为部分统计起点", () => {
  const midnight = Date.parse("2026-11-18T16:00:00Z");
  const first = midnight + 8 * 3_600_000 + 35 * 60_000;
  const last = first + 15 * 60_000;
  const day = { equity: [[first, 2000], [last, 1950]], pnl: [[first, 100], [last, 82]] };
  const { data, equityStart, points } = todayPortfolio({ day }, null, last);
  assert.deepEqual(data, { start: first, asOf: last, pnl: -18, equity: 2000, estimated: false, equityEstimated: false });
  assert.equal(equityStart, first);
  assert.deepEqual(points.pnl, [[first, 0], [last, -18]]);
  assert.equal(todayPortfolio({ day }, null, first).data, null);
});

test("仅对有共同基准的历史盈亏补样，权益可以独立继续展示", () => {
  const midnight = Date.parse("2026-11-18T16:00:00Z");
  const first = midnight + 3_600_000;
  const last = first + 60_000;
  const day = { pnl: [[first, 110], [last, 130]], equity: [[first, 1900], [last, 1920]] };
  const archived = { pnl: [[midnight, 105], [first, 110], [last, 130]], equity: [[midnight, 1885]] };
  const recovered = todayPortfolio({ day }, archived, last);
  assert.equal(recovered.data.start, midnight);
  assert.equal(recovered.data.pnl, 25);
  assert.equal(recovered.data.equity, 1885);
  archived.pnl[1][1] = 10;
  const drift = todayPortfolio({ day }, archived, last);
  assert.equal(drift.data.start, first);
  assert.equal(drift.data.pnl, 20);
  assert.equal(drift.equityStart, midnight);
  assert.deepEqual(todayPortfolio(null, archived, last).points.pnl, []);
});

test("近 7 天从区间内首个盈亏样本起算，百分比只采用同时刻的权益", () => {
  const now = Date.parse("2026-11-19T05:00:00Z");
  const cutoff = now - 7 * day;
  const start = cutoff + 53 * 60_000;
  const prior = cutoff - 3 * 3_600_000;
  const history = {
    week: { equity: [[prior, 500], [start, 195.97], [now, 2100]], pnl: [[prior, 500], [start, 0], [now, -129.98]] },
  };
  const result = periodPnl(history, "week", now);
  assert.equal(result.start, start);
  assert.equal(result.pnl, -129.98);
  assert.equal(result.equity, 195.97);
  assert.equal((100 * result.pnl / result.equity).toFixed(2), "-66.33");
  assert.deepEqual(portfolioPeriodPoints(history, "week", "pnl", now), [[start, 0], [now, -129.98]]);
  history.week.equity.splice(1, 1);
  assert.equal(periodPnl(history, "week", now).equity, null);
});

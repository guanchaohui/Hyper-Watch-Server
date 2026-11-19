import { cashMovements, day, fillIdentity, isPerpCoin, numberOf, positionChanges, utc8DayStart } from "./analytics.js";
import { hyperliquidInfo } from "./hyperliquid.js";

const cached = new Map();
const cacheAge = 60_000;
const eventLimit = 6;

function boundedTime(row, start, end) {
  const time = numberOf(row?.time);
  return Number.isSafeInteger(time) && time >= start && time <= end;
}

function fillsOverview(raw, since, asOf) {
  if (!Array.isArray(raw)) return { fillsState: "unavailable", realized: null, events: [] };
  const start = utc8DayStart(asOf);
  const rows = raw.filter(row => boundedTime(row, since, asOf));
  const perp = rows.filter(row => isPerpCoin(row.coin));
  const today = new Map(perp.filter(row => Number(row.time) >= start).map(row => [fillIdentity(row), row]));
  const pnls = [...today.values()].map(row => numberOf(row.closedPnl));
  // A page at the general time-range limit needs explicit pagination before it can be treated as complete.
  const limited = raw.length >= 500;
  const incomplete = rows.length !== raw.length || rows.some(row => typeof row.coin !== "string" || !row.coin) || pnls.includes(null);
  const fillsState = limited ? "limited" : incomplete ? "incomplete" : "ready";
  const events = positionChanges(perp).filter(row => ["open", "close", "reverse"].includes(row.action))
    .slice(-eventLimit).map(row => ({
      type: row.action, time: row.time, coin: row.coin, side: (row.end || row.start) > 0 ? "long" : "short",
      amount: row.value,
    }));
  return { fillsState, realized: fillsState === "ready" ? pnls.reduce((sum, pnl) => sum + pnl, 0) : null, events };
}

function ledgerOverview(raw, since, asOf) {
  if (!Array.isArray(raw)) return { ledgerState: "unavailable", events: [] };
  const recent = raw.filter(row => boundedTime(row, since, asOf));
  const unique = new Map(recent.map(row => [JSON.stringify([row.hash, row.time, row.delta]), row]));
  const events = cashMovements([...unique.values()]).sort((a, b) => b.time - a.time).slice(0, eventLimit);
  const missing = recent.length !== raw.length || recent.some(row => !row.delta?.type ||
    (["deposit", "withdraw"].includes(row.delta.type) && numberOf(row.delta.usdc) === null));
  const ledgerState = raw.length >= 500 ? "limited" : missing ? "incomplete" : "ready";
  return { ledgerState, events };
}

async function fetchActivity(user, asOf) {
  const since = asOf - day;
  const window = { user, startTime: since, endTime: asOf };
  const [fills, ledger] = await Promise.allSettled([
    hyperliquidInfo({ type: "userFillsByTime", ...window, aggregateByTime: false }),
    hyperliquidInfo({ type: "userNonFundingLedgerUpdates", ...window }),
  ]);
  const { fillsState, realized, events: trades } = fillsOverview(fills.value, since, asOf);
  const { ledgerState, events: movements } = ledgerOverview(ledger.value, since, asOf);
  return { asOf, since, todayStart: utc8DayStart(asOf), fillsState, ledgerState, realized, events: [...trades, ...movements] };
}

function marketActivity(wallet, now) {
  const prior = cached.get(wallet);
  if (prior && (prior.pending || (now - prior.at < cacheAge && utc8DayStart(prior.at) === utc8DayStart(now)))) {
    return prior.result;
  }
  const entry = { at: now, pending: true, result: fetchActivity(wallet, now).finally(() => { entry.pending = false; }) };
  cached.delete(wallet);
  if (cached.size >= 128) cached.delete(cached.keys().next().value);
  cached.set(wallet, entry);
  return entry.result;
}

export async function readOverviewActivity(db, account, wallet, now = Date.now()) {
  const [market, risk] = await Promise.all([
    marketActivity(wallet, now),
    db.prepare(
      "SELECT event_id AS id, created_at AS time FROM alerts WHERE user_id = ? AND created_at BETWEEN ? AND ? " +
      "AND (event_id LIKE ? OR event_id LIKE ? OR event_id LIKE ?) ORDER BY created_at DESC LIMIT ?",
    ).bind(account, now - day, now, "risk:" + wallet + ":%", "equity:" + wallet + ":%", "leverage:" + wallet + ":%", eventLimit).all(),
  ]);
  const notices = risk.results.map(row => ({ type: row.id.split(":", 1)[0], time: row.time }));
  const events = [...market.events, ...notices].sort((a, b) => b.time - a.time).slice(0, eventLimit);
  return { ...market, events };
}

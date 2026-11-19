import { cashMovements, cleanProfile, day, fillIdentity, isPerpCoin, numberOf, positionChanges, utc8DayStart } from "./analytics.js";
import { hyperliquidInfo } from "./hyperliquid.js";

const cached = new Map();
const cacheAge = 60_000;
const eventLimit = 6;
const archiveLag = 120_000;
const archiveLimit = 20_000;
const activityTypes = { fill: "userFillsByTime", ledger: "userNonFundingLedgerUpdates" };

function boundedTime(row, start, end) {
  const time = numberOf(row?.time);
  return Number.isSafeInteger(time) && time >= start && time <= end;
}

function fillsOverview(raw, since, asOf, archived = false) {
  if (!Array.isArray(raw)) return { fillsState: "unavailable", realized: null, events: [] };
  const start = utc8DayStart(asOf);
  const rows = raw.filter(row => boundedTime(row, since, asOf));
  const perp = rows.filter(row => isPerpCoin(row.coin));
  const today = new Map(perp.filter(row => Number(row.time) >= start).map(row => [fillIdentity(row), row]));
  const pnls = [...today.values()].map(row => numberOf(row.closedPnl));
  // A page at the general time-range limit needs explicit pagination before it can be treated as complete.
  const limited = raw.length >= (archived ? archiveLimit + 1 : 500);
  const incomplete = rows.length !== raw.length || rows.some(row => typeof row.coin !== "string" || !row.coin) || pnls.includes(null);
  const fillsState = limited ? "limited" : incomplete ? "incomplete" : "ready";
  const events = positionChanges(perp).filter(row => ["open", "close", "reverse"].includes(row.action))
    .slice(-eventLimit).map(row => ({
      type: row.action, time: row.time, coin: row.coin, side: (row.end || row.start) > 0 ? "long" : "short",
      amount: row.value,
    }));
  return { fillsState, realized: fillsState === "ready" ? pnls.reduce((sum, pnl) => sum + pnl, 0) : null, events };
}

function ledgerOverview(raw, since, asOf, archived = false) {
  if (!Array.isArray(raw)) return { ledgerState: "unavailable", events: [] };
  const recent = raw.filter(row => boundedTime(row, since, asOf));
  const unique = new Map(recent.map(row => [JSON.stringify([row.hash, row.time, row.delta]), row]));
  const events = cashMovements([...unique.values()]).sort((a, b) => b.time - a.time).slice(0, eventLimit);
  const missing = recent.length !== raw.length || recent.some(row => !row.delta?.type ||
    (["deposit", "withdraw"].includes(row.delta.type) && numberOf(row.delta.usdc) === null));
  const ledgerState = raw.length >= (archived ? archiveLimit + 1 : 500) ? "limited" : missing ? "incomplete" : "ready";
  return { ledgerState, events };
}

function liveActivity(wallet, kind, now) {
  const key = wallet + ":" + kind;
  const prior = cached.get(key);
  if (prior && utc8DayStart(prior.at) === utc8DayStart(now) && (prior.pending || now - prior.at < cacheAge)) return prior.result;
  const since = now - day;
  const query = { type: activityTypes[kind], user: wallet, startTime: since, endTime: now,
    ...(kind === "fill" ? { aggregateByTime: false } : {}) };
  const read = kind === "fill" ? fillsOverview : ledgerOverview;
  const entry = { at: now, pending: true };
  entry.result = hyperliquidInfo(query).then(rows => read(rows, since, now), () => read(null, since, now))
    .then(data => ({ ...data, since, asOf: now })).finally(() => { entry.pending = false; });
  cached.delete(key);
  if (cached.size >= 256) cached.delete(cached.keys().next().value);
  cached.set(key, entry);
  return entry.result;
}

async function archiveActivity(db, wallet, kind, since, now) {
  const state = await db.prepare("SELECT since, through FROM market_coverage WHERE wallet=? AND kind=?").bind(wallet, kind).first();
  if (!Number.isSafeInteger(state?.since) || !Number.isSafeInteger(state.through) || state.through < since) return null;
  const asOf = Math.min(state.through, now);
  const { results } = await db.prepare(
    "SELECT event_at, payload FROM market_records WHERE wallet=? AND kind=? AND event_at BETWEEN ? AND ? ORDER BY event_at,event_id LIMIT ?",
  ).bind(wallet, kind, Math.max(since, state.since), asOf, archiveLimit + 1).all();
  const rows = results.map(row => ({ ...JSON.parse(row.payload), time: row.event_at }));
  const read = kind === "fill" ? fillsOverview : ledgerOverview;
  const data = read(rows, since, asOf, true);
  return { ...data, since: state.since, asOf, recent: state.since <= since && asOf >= now - archiveLag };
}

async function fetchActivity(db, account, wallet, now) {
  const since = now - day;
  const todayStart = utc8DayStart(now);
  const profile = await db.prepare("SELECT settings FROM profiles WHERE user_id=?").bind(account).first();
  const saved = profile && cleanProfile(JSON.parse(profile.settings)).wallets.some(entry => entry.address === wallet);
  const [storedFills, storedLedger] = saved ? await Promise.all([
    archiveActivity(db, wallet, "fill", since, now),
    archiveActivity(db, wallet, "ledger", since, now),
  ]) : [];
  const confirmedToday = storedFills?.fillsState === "ready" && storedFills.since <= todayStart && storedFills.asOf >= todayStart;
  const [fills, ledger] = await Promise.all([
    confirmedToday && storedFills.asOf >= now - archiveLag ? storedFills : liveActivity(wallet, "fill", now),
    storedLedger?.recent && storedLedger.ledgerState === "ready" ? storedLedger : liveActivity(wallet, "ledger", now),
  ]);
  const realized = fills.fillsState === "ready" ? fills : confirmedToday ? storedFills : fills;
  const latestTrades = fills.fillsState === "unavailable" && storedFills ? storedFills : fills;
  const latestLedger = ledger.ledgerState === "unavailable" && storedLedger ? storedLedger : ledger;
  return {
    asOf: Math.min(fills.asOf, ledger.asOf), since, todayStart,
    realized: realized.realized, fillsState: realized.fillsState, realizedAsOf: realized.fillsState === "ready" ? realized.asOf : null,
    tradeEventsState: fills === storedFills && !storedFills.recent ? "incomplete" : fills.fillsState,
    ledgerState: ledger.ledgerState,
    events: [...latestTrades.events, ...latestLedger.events],
  };
}

export async function readOverviewActivity(db, account, wallet, now = Date.now()) {
  const [market, risk] = await Promise.all([
    fetchActivity(db, account, wallet, now),
    db.prepare(
      "SELECT event_id AS id, created_at AS time FROM alerts WHERE user_id = ? AND created_at BETWEEN ? AND ? " +
      "AND (event_id LIKE ? OR event_id LIKE ? OR event_id LIKE ?) ORDER BY created_at DESC LIMIT ?",
    ).bind(account, now - day, now, "risk:" + wallet + ":%", "equity:" + wallet + ":%", "leverage:" + wallet + ":%", eventLimit).all(),
  ]);
  const notices = risk.results.map(row => ({ type: row.id.split(":", 1)[0], time: row.time }));
  const events = [...market.events, ...notices].sort((a, b) => b.time - a.time).slice(0, eventLimit);
  return { ...market, events };
}

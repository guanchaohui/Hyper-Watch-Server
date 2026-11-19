import { day, numberOf } from "./analytics.js";
import { hyperliquidInfo, perpMarkets } from "./hyperliquid.js";
import { marketRecord, marketRecordWrites, monitoredWallets } from "./market-ledger.js";
import { parsePortfolio } from "./market.js";

const minute = 60_000;
const lookback = 32 * day;
const historyTypes = { fill: "userFillsByTime", funding: "userFunding", ledger: "userNonFundingLedgerUpdates" };

function readState(db, wallet, kind) {
  return db.prepare("SELECT * FROM market_coverage WHERE wallet = ? AND kind = ?").bind(wallet, kind).first();
}
function stateWrite(db, wallet, kind, since, through, checked, status, span) {
  return db.prepare("INSERT INTO market_coverage VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(wallet, kind) DO UPDATE SET " +
    "since = excluded.since, through = excluded.through, checked_at = excluded.checked_at, status = excluded.status, span = excluded.span")
    .bind(wallet, kind, since, through, checked, status, span);
}

export async function syncHistory(db, wallet, kind, now, preferHistory = false) {
  const prior = await readState(db, wallet, kind);
  let since = prior?.since ?? null;
  let through = prior?.through ?? null;
  const span = prior?.span ?? day;
  if (prior && now - prior.checked_at < 25_000) return;
  const hasHistoryToBackfill = since !== null && since > now - lookback && prior?.status !== "retention";
  const forward = through !== null && (!hasHistoryToBackfill || (!preferHistory && now - through > minute));
  const end = through === null ? now : forward ? Math.min(now, through + span) : since - 1;
  const start = forward ? through + 1 : Math.max(end - span + 1, now - lookback);
  if (end < start) return;
  const type = historyTypes[kind];
  const payload = { type, user: wallet, startTime: start, endTime: end, ...(kind === "fill" ? { aggregateByTime: false } : {}) };
  let raw;
  try {
    raw = await hyperliquidInfo(payload);
    if (!Array.isArray(raw)) throw Error("Invalid history");
  } catch {
    await stateWrite(db, wallet, kind, since, through, now, "unavailable", span).run();
    return;
  }
  const records = raw.map(row => marketRecord(kind, row)).filter(Boolean);
  const limited = raw.length >= 500 || records.length !== raw.length || raw.some(row => {
    const time = numberOf(row?.time);
    return time === null || time < start || time > end;
  });
  let retention = false;
  if (kind === "fill" && !limited && !forward) {
    const priorCount = since === null ? null :
      await db.prepare("SELECT COUNT(*) AS n FROM market_records WHERE wallet = ? AND kind = 'fill' AND event_at >= ?")
        .bind(wallet, since).first();
    retention = (Number(priorCount?.n) || 0) + new Set(records.map(row => row.id)).size >= 10_000;
  }
  if (!limited && !retention) {
    if (since === null || !forward) since = start;
    if (through === null || forward) through = end;
  }
  const status = retention ? "retention" : limited ? "limited" : "ready";
  const nextSpan = limited ? Math.max(1, Math.floor(span / 2)) : Math.min(day, span * 2);
  await db.batch([
    ...marketRecordWrites(db, wallet, kind, records, true),
    stateWrite(db, wallet, kind, since, through, now, status, nextSpan),
  ]);
}

async function syncEquity(db, wallet, now) {
  const previous = await readState(db, wallet, "equity");
  if (previous && now - previous.checked_at < 45_000) return;
  try {
    const portfolio = parsePortfolio(await hyperliquidInfo({ type: "portfolio", user: wallet }));
    const points = new Map();
    for (const [time, value] of portfolio.day?.equity ?? []) points.set(time, { equity: value });
    for (const [time, value] of portfolio.day?.pnl ?? []) {
      points.set(time, { ...points.get(time), pnl: value });
    }
    const times = [...points.keys()];
    const sample = db.prepare("INSERT INTO wallet_equity_history VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(wallet,sampled_at) DO UPDATE SET equity = COALESCE(excluded.equity,equity), pnl = COALESCE(excluded.pnl,pnl)");
    await db.batch([
      ...times.map(time => sample.bind(wallet, time, points.get(time).equity?.toString() ?? null, points.get(time).pnl?.toString() ?? null)),
      stateWrite(db, wallet, "equity", times.length ? Math.min(previous?.since ?? Infinity, ...times) : previous?.since ?? null,
        times.length ? Math.max(previous?.through ?? 0, ...times) : previous?.through ?? null, now, times.length ? "ready" : "unavailable", day),
    ]);
  } catch {
    await stateWrite(db, wallet, "equity", previous?.since ?? null, previous?.through ?? null, now, "unavailable", day).run();
  }
}

async function syncOrders(db, wallet, now) {
  const prior = await readState(db, wallet, "order");
  if (!prior || now - prior.checked_at >= 2 * minute) {
    try {
      const raw = await hyperliquidInfo({ type: "historicalOrders", user: wallet });
      if (!Array.isArray(raw)) throw Error("Invalid history");
      const records = raw.map(row => marketRecord("order", row)).filter(Boolean);
      const since = records.length ? Math.min(...records.map(r => r.time)) : null;
      await db.batch([...marketRecordWrites(db, wallet, "order", records, true),
        stateWrite(db, wallet, "order", since, now, now, raw.length >= 2000 || records.length !== raw.length ? "limited" : "ready", day)]);
    } catch {
      await stateWrite(db, wallet, "order", prior?.since ?? null, prior?.through ?? null, now, "unavailable", day).run();
    }
  }
  const book = await readState(db, wallet, "open");
  if (book && now - book.checked_at < (book.status === "ready" ? 2 * minute : minute)) return;
  try {
    const markets = await perpMarkets();
    const snapshots = await Promise.all(markets.map(dex => hyperliquidInfo({ type: "frontendOpenOrders", user: wallet, ...(dex ? { dex } : {}) })));
    if (!snapshots.every(rows => Array.isArray(rows) && rows.every(row => row && typeof row.coin === "string" && row.oid != null))) {
      throw Error("Invalid open orders");
    }
    const orders = [...new Map(snapshots.flat().map(row => [row.coin + ":" + row.oid, row])).values()];
    await db.batch([
      db.prepare("INSERT INTO wallet_open_orders VALUES (?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET checked_at=excluded.checked_at,payload=excluded.payload")
        .bind(wallet, now, JSON.stringify(orders)),
      stateWrite(db, wallet, "open", now, now, now, "ready", day),
    ]);
  } catch {
    await stateWrite(db, wallet, "open", book?.since ?? null, book?.through ?? null, now, "unavailable", day).run();
  }
}

export function startLedgerSync(db) {
  let cursor = 0;
  let running = false;
  const lastPass = new Map();
  async function tick() {
    if (running) return;
    running = true;
    try {
      const wallets = await monitoredWallets(db);
      if (!wallets.length) return;
      for (const address of lastPass.keys()) if (!wallets.includes(address)) lastPass.delete(address);
      const address = wallets[cursor++ % wallets.length];
      const now = Date.now();
      const preferHistory = lastPass.get(address) === false;
      lastPass.set(address, preferHistory);
      for (const kind of Object.keys(historyTypes)) await syncHistory(db, address, kind, now, preferHistory);
      await syncEquity(db, address, now);
      await syncOrders(db, address, now);
    } catch {
      console.warn("账户历史同步暂未完成，下一轮重试。");
    } finally { running = false; }
  }
  const timer = setInterval(tick, 15_000);
  const initial = setTimeout(tick, 8000);
  timer.unref();
  initial.unref();
  return () => { clearInterval(timer); clearTimeout(initial); };
}

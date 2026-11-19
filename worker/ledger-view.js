import { day } from "./analytics.js";
import { movementOf, periodStart, positionHistory, summarizeAccount } from "./accounting.js";
import { fullPositionSnapshot } from "./position-source.js";

export const ledgerViews = ["summary", "fill", "funding", "ledger", "open", "order", "positions", "equity"];
export const ledgerPeriods = ["today", "week", "month", "30d"];
const pageSize = 30;
const maxCalculationRows = 20_000;
const minute = 60_000;

async function records(db, wallet, kind, start, end, max) {
  const { results } = await db.prepare(
    "SELECT event_at AS time,payload FROM market_records WHERE wallet=? AND kind=? AND event_at BETWEEN ? AND ? ORDER BY event_at DESC,event_id DESC LIMIT ?",
  ).bind(wallet, kind, start, end, max + 1).all();
  return { overLimit: results.length > max, rows: results.slice(0, max).map(row => ({ ...JSON.parse(row.payload), time: row.time })) };
}

export async function readWalletLedger(db, wallet, { view, period, before, now = Date.now() }) {
  const since = periodStart(period, now);
  const { results: states } = await db.prepare("SELECT kind, since, through, checked_at AS checkedAt, status FROM market_coverage WHERE wallet=?").bind(wallet).all();
  const coverage = Object.fromEntries(states.map(row => [row.kind, row]));
  const covered = (kind, start, end) => coverage[kind]?.since != null && coverage[kind]?.through != null &&
    coverage[kind].since <= start && coverage[kind].through >= end;
  for (const [kind, state] of Object.entries(coverage)) {
    state.full = covered(kind, since, Math.max(since, now - 2 * minute));
  }
  const common = { since, asOf: now, coverage };
  if (view === "summary") {
    const [fills, funding, cash, positions] = await Promise.all([
      records(db, wallet, "fill", since, now, maxCalculationRows),
      records(db, wallet, "funding", since, now, maxCalculationRows),
      records(db, wallet, "ledger", since, now, maxCalculationRows),
      fullPositionSnapshot(wallet).catch(() => null),
    ]);
    const summary = summarizeAccount({ fills: fills.rows, funding: funding.rows, cash: cash.rows });
    if (!fills.rows.length && coverage.fill?.through == null) {
      summary.realized = summary.tradeCount = summary.notional = summary.fees = summary.builderFees = null;
    }
    if (!funding.rows.length && coverage.funding?.through == null) summary.fundingIncome = summary.fundingPaid = null;
    if (!cash.rows.length && coverage.ledger?.through == null) summary.cash = null;
    const unrealized = positions?.rows.every(row => Number.isFinite(row.pnl)) ? positions.rows.reduce((sum, row) => sum + row.pnl, 0) : null;
    return { ...common, summary, unrealized, positionsAt: positions?.at ?? null,
      truncated: fills.overLimit || funding.overLimit || cash.overLimit };
  }
  if (view === "open") {
    const row = await db.prepare("SELECT checked_at AS time,payload FROM wallet_open_orders WHERE wallet=?").bind(wallet).first();
    const payload = row ? JSON.parse(row.payload) : null;
    return { ...common, rows: payload?.slice(0, 1000) ?? null, snapshotAt: row?.time ?? null,
      truncated: (payload?.length ?? 0) > 1000, stale: row && now - row.time > 3 * minute };
  }
  if (view === "positions") {
    // Include prior available fills so a lifecycle can begin before the selected reporting window.
    const [fills, funding] = await Promise.all([
      records(db, wallet, "fill", 0, now, maxCalculationRows),
      records(db, wallet, "funding", 0, now, maxCalculationRows),
    ]);
    const history = positionHistory(fills.rows, funding.rows,
      (kind, start, end) => !(kind === "fill" ? fills.overLimit : funding.overLimit) && covered(kind, start, end))
      .filter(row => row.last >= since);
    return { ...common, rows: history.slice(0, 60).map(row => ({ ...row, steps: row.steps.slice(-80), stepCount: row.steps.length })),
      truncated: history.length > 60 || fills.overLimit || funding.overLimit };
  }

  const equity = view === "equity";
  const timeCol = equity ? "sampled_at" : "event_at", idCol = equity ? "sampled_at" : "event_id";
  const table = equity ? "wallet_equity_history" : "market_records";
  const filters = "wallet=? AND " + (equity ? "" : "kind=? AND ") + timeCol + " BETWEEN ? AND ?";
  const cut = before ? " AND (" + timeCol + "< ? OR (" + timeCol + "=? AND " + idCol + "< ?))" : "";
  const params = [wallet, ...(equity ? [] : [view]), since, now];
  if (before) params.push(before.time, before.time, equity ? before.time : before.id);
  const { results } = await db.prepare("SELECT " + timeCol + " AS time," + idCol + " AS id," +
    (equity ? "equity,pnl" : "payload") + " FROM " + table + " WHERE " + filters + cut +
    " ORDER BY " + timeCol + " DESC," + idCol + " DESC LIMIT ?").bind(...params, pageSize + 1).all();
  const rows = results.slice(0, pageSize).map(row => ({
    time: row.time, id: String(row.id), data: equity ? { equity: row.equity, pnl: row.pnl } :
      view === "ledger" ? movementOf(JSON.parse(row.payload)) : JSON.parse(row.payload),
  }));
  const last = rows.at(-1);
  return { ...common, rows, next: results.length > pageSize ? { time: last.time, id: last.id } : null };
}

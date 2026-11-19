import { decimal, decimalText } from "./accounting.js";
import { addressOf, cleanProfile, numberOf } from "./analytics.js";

const validTime = value => Number.isSafeInteger(numberOf(value)) && Number(value) > 0;
const validText = value => typeof value === "string" && value.length > 0;
const scalar = value => value === null || value === undefined ? null : String(value).trim();
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
};

export function marketRecord(kind, row) {
  if (!row || typeof row !== "object") return null;
  const time = numberOf(kind === "order" ? row.statusTimestamp : row.time);
  if (!validTime(time)) return null;
  let key, data;
  if (kind === "fill") {
    if (!validText(row.coin) || !(numberOf(row.px) > 0) || !(numberOf(row.sz) > 0) ||
      (row.side !== "A" && row.side !== "B")) return null;
    if (row.tid == null && (!validText(row.hash) || row.oid == null)) return null;
    key = [time, row.coin, scalar(row.tid) ?? [row.hash, scalar(row.oid), row.side, scalar(row.sz), scalar(row.startPosition)]];
    data = { ...row, time };
  } else if (kind === "funding") {
    const delta = row.delta ?? row;
    if (!validText(delta.coin) || numberOf(delta.usdc) === null) return null;
    // The WS and REST timestamps and trade IDs differ for funding. Settlement is on the hour.
    const hour = Math.floor(time / 3_600_000) * 3_600_000;
    key = [hour, delta.coin];
    data = { coin: delta.coin, usdc: scalar(delta.usdc), token: scalar(delta.token), fundingRate: scalar(delta.fundingRate) };
    return { id: JSON.stringify(key), time: hour, data };
  } else if (kind === "ledger") {
    if (!validText(row.hash) || !validText(row.delta?.type)) return null;
    const delta = stable(row.delta);
    // Amount fields may be numbers on WS and decimal strings on REST.
    for (const name of ["usdc", "amount", "fee", "nonce", "usdcValue", "netWithdrawnUsd"]) {
      if (Object.hasOwn(delta, name)) delta[name] = decimalText(decimal(delta[name])) ?? scalar(delta[name]);
    }
    key = [time, row.hash, delta.type, delta.user ?? "", delta.destination ?? "", delta.token ?? "",
      delta.usdc ?? delta.amount ?? "", delta.nonce ?? "", delta.toPerp ?? "", delta.vault ?? ""];
    data = { time, hash: row.hash, delta };
  } else if (kind === "order") {
    if (!validText(row.order?.coin) || row.order.oid == null || !validText(row.status)) return null;
    key = [row.order.coin, scalar(row.order.oid), row.status, time];
    data = { status: row.status, statusTimestamp: time, order: row.order };
  } else return null;
  return { id: JSON.stringify(key), time, data };
}

export function marketRecordWrites(db, wallet, kind, records, preferRest = false) {
  if (!records.length) return [];
  // Some REST order records supply fields missing from the WebSocket update.
  const conflict = preferRest ? "DO UPDATE SET event_at = excluded.event_at, payload = excluded.payload" : "DO NOTHING";
  const statement = db.prepare("INSERT INTO market_records VALUES (?, ?, ?, ?, ?) ON CONFLICT(wallet, kind, event_id) " + conflict);
  return records.map(({ id, time, data }) => statement.bind(wallet, kind, id, time, JSON.stringify(data)));
}

export async function recordMarketRows(db, wallet, kind, rows) {
  if (!addressOf(wallet) || !Array.isArray(rows)) return;
  const records = rows.map(row => marketRecord(kind, row)).filter(Boolean);
  if (records.length) await db.batch(marketRecordWrites(db, wallet, kind, records));
}

export async function monitoredWallets(db, alertsFirst = false) {
  const { results } = await db.prepare("SELECT settings FROM profiles ORDER BY rowid").all();
  const alerts = new Set(), own = new Set(), all = new Set();
  for (const row of results) {
    const profile = cleanProfile(JSON.parse(row.settings));
    for (const wallet of profile.wallets) {
      if (alertsFirst && wallet.notify && profile.rules.actions.length) alerts.add(wallet.address);
      if (wallet.role === "mine") own.add(wallet.address);
      all.add(wallet.address);
    }
  }
  return [...new Set([...alerts, ...own, ...all])];
}

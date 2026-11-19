import { day, isPerpCoin, utc8DayStart } from "./analytics.js";

const decimals = 18;
const scale = 10n ** BigInt(decimals);
const offset = 8 * 3_600_000;

export function decimal(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = String(value).trim().match(/^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match || match[2].length + (match[3]?.length ?? 0) > 80) return null;
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 40) return null;
  const precision = (match[3] ?? "").length - exponent;
  const amount = BigInt(match[2] + (match[3] ?? ""));
  const sign = match[1] === "-" ? -1n : 1n;
  if (precision <= decimals) return sign * amount * 10n ** BigInt(decimals - precision);
  const unit = 10n ** BigInt(precision - decimals);
  return amount % unit === 0n ? sign * amount / unit : null;
}

export function decimalText(value) {
  if (value === null) return null;
  const sign = value < 0n ? "-" : "";
  const magnitude = value < 0n ? -value : value;
  const fraction = String(magnitude % scale).padStart(decimals, "0").replace(/0+$/, "");
  return sign + String(magnitude / scale) + (fraction ? "." + fraction : "");
}

export function periodStart(period, now) {
  const today = utc8DayStart(now);
  const local = new Date(today + offset);
  if (period === "week") return today - ((local.getUTCDay() + 6) % 7) * day;
  if (period === "month") return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offset;
  if (period === "30d") return today - 29 * day;
  return today;
}

const add = (map, token, value) => map.set(token, (map.get(token) ?? 0n) + value);
const entries = map => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)).map(([token, value]) => [token, decimalText(value)]));
const tokenOf = value => typeof value === "string" && value.trim() ? value.trim() : "币种未提供";
const flowTypes = new Set(["internalTransfer", "subAccountTransfer", "accountClassTransfer", "spotTransfer", "send", "dexTransfer"]);

export function movementOf(row) {
  const delta = row.delta;
  const amount = decimal(delta?.usdc ?? delta?.amount ?? delta?.netWithdrawnUsd);
  return {
    type: delta?.type,
    bucket: delta?.type === "deposit" ? "deposit" : delta?.type === "withdraw" ? "withdraw" : flowTypes.has(delta?.type) ? "transfer" : "other",
    token: tokenOf(delta?.token ?? (delta?.usdc != null || delta?.netWithdrawnUsd != null ? "USDC" : null)),
    amount: decimalText(amount), from: delta?.user, to: delta?.destination, toPerp: delta?.toPerp,
  };
}

export function summarizeAccount({ fills, funding, cash }) {
  const marketFees = new Map(), builderFees = new Map(), fundsIn = new Map(), fundsOut = new Map();
  const cashTotals = Object.fromEntries(["deposit", "withdraw", "transfer", "other"].map(key => [key, new Map()]));
  let pnl = 0n, notional = 0n, feesMissing = false, pnlMissing = false, fundingMissing = false;
  for (const row of fills) {
    const token = tokenOf(row.feeToken);
    const fee = decimal(row.fee);
    const builder = row.builderFee == null ? 0n : decimal(row.builderFee);
    if (builder !== null && builder !== 0n) add(builderFees, token, builder);
    if (fee === null || builder === null) feesMissing = true;
    else add(marketFees, token, fee - builder);
    if (isPerpCoin(row.coin)) {
      const realized = decimal(row.closedPnl);
      const size = decimal(row.sz), price = decimal(row.px);
      if (size !== null && price !== null) notional += size * price / scale;
      if (realized === null) pnlMissing = true;
      else pnl += realized;
    }
  }
  for (const row of funding) {
    const value = decimal(row.usdc);
    if (value === null) { fundingMissing = true; continue; }
    const token = tokenOf(row.token ?? (row.coin.includes(":") ? "HIP-3 结算金额" : "USDC"));
    add(value >= 0n ? fundsIn : fundsOut, token, value >= 0n ? value : -value);
  }
  let cashMissing = false;
  for (const row of cash) {
    const flow = movementOf(row);
    const amount = decimal(flow.amount);
    if (amount === null) { if (flow.bucket !== "other") cashMissing = true; continue; }
    add(cashTotals[flow.bucket], flow.token, amount < 0n ? -amount : amount);
  }
  return {
    realized: pnlMissing ? null : decimalText(pnl), tradeCount: fills.length, notional: decimalText(notional),
    fees: feesMissing ? null : entries(marketFees), builderFees: feesMissing ? null : entries(builderFees),
    fundingIncome: fundingMissing ? null : entries(fundsIn), fundingPaid: fundingMissing ? null : entries(fundsOut),
    cash: Object.fromEntries(Object.entries(cashTotals).map(([key, map]) => [key, entries(map)])), cashMissing,
  };
}

function openSession(row, detail, complete) {
  return { coin: row.coin, start: complete ? row.time : null, firstSeen: row.time,
    side: detail.side, complete, steps: [], realized: 0n, pnlKnown: true,
    feeComplete: true, marketFees: new Map(), builderFees: new Map() };
}

function recordSession(session, row, action, before, after, realized, split = false) {
  session.steps.push({ time: row.time, action, before: decimalText(before), after: decimalText(after), price: row.px });
  const pnl = decimal(realized);
  if (pnl === null) session.pnlKnown = false;
  else session.realized += pnl;
  const fee = decimal(row.fee);
  const builder = row.builderFee == null ? 0n : decimal(row.builderFee);
  if (split || fee === null || builder === null) session.feeComplete = false;
  else {
    const token = tokenOf(row.feeToken);
    add(session.marketFees, token, fee - builder);
    if (builder !== 0n) add(session.builderFees, token, builder);
  }
  session.last = row.time;
}

export function positionHistory(fills, funding, covered) {
  const pending = new Map(), finished = [];
  const sizeOf = n => n < 0n ? -n : n;
  const sign = n => n > 0n ? "long" : "short";
  const ordered = [...fills].filter(row => isPerpCoin(row.coin))
    .sort((a, b) => a.time - b.time || (Number(a.tid) - Number(b.tid) || 0));
  function finish(session, end) {
    const complete = Boolean(end && session.complete && covered("fill", session.start, end));
    const fundingKnown = complete && covered("funding", session.start, end);
    const payments = new Map();
    let parsedFunding = fundingKnown;
    if (fundingKnown) {
      for (const item of funding) {
        if (item.coin !== session.coin || item.time < session.start || item.time >= end) continue;
        const value = decimal(item.usdc);
        if (value === null) { parsedFunding = false; break; }
        const token = tokenOf(item.token ?? (item.coin.includes(":") ? "HIP-3 结算金额" : "USDC"));
        add(payments, token, value);
      }
    }
    const realized = complete && session.pnlKnown ? session.realized : null;
    const feeTokens = [...session.marketFees.keys()];
    const net = realized !== null && parsedFunding && session.feeComplete && feeTokens.every(t => t === "USDC") &&
      !session.coin.includes(":") && [...payments.keys()].every(t => t === "USDC")
      ? realized + (payments.get("USDC") ?? 0n) -
        (session.marketFees.get("USDC") ?? 0n) - (session.builderFees.get("USDC") ?? 0n) : null;
    finished.push({
      coin: session.coin, side: session.side, start: session.start, firstSeen: session.firstSeen, end,
      last: session.last, complete, realized: decimalText(realized),
      fees: complete && session.feeComplete ? entries(session.marketFees) : null,
      builderFees: complete && session.feeComplete ? entries(session.builderFees) : null,
      funding: parsedFunding ? entries(payments) : null, net: decimalText(net),
      steps: session.steps, size: end ? "0" : decimalText(session.expected ?? null),
    });
  }
  for (const row of ordered) {
    const before = decimal(row.startPosition), size = decimal(row.sz);
    if (before === null || size === null || size <= 0n || !["A", "B"].includes(row.side)) {
      const prior = pending.get(row.coin);
      if (prior) prior.complete = false;
      continue;
    }
    const after = before + (row.side === "B" ? size : -size);
    let session = pending.get(row.coin);
    if (session && session.expected !== before) {
      session.complete = false;
      finish(session, null);
      pending.delete(row.coin);
      session = null;
    }
    if (!session) {
      session = openSession(row, { side: sign(before || after) }, before === 0n);
      pending.set(row.coin, session);
    }
    if (before !== 0n && after !== 0n && sign(before) !== sign(after)) {
      recordSession(session, row, "reverseClose", before, 0n, row.closedPnl, true);
      finish(session, row.time);
      session = openSession(row, { side: sign(after) }, true);
      pending.set(row.coin, session);
      recordSession(session, row, "reverseOpen", 0n, after, "0", true);
    } else {
      const action = before === 0n ? "open" : after === 0n ? "close" : sizeOf(after) > sizeOf(before) ? "add" : "reduce";
      recordSession(session, row, action, before, after, row.closedPnl);
    }
    session.expected = after;
    if (after === 0n) {
      finish(session, row.time);
      pending.delete(row.coin);
    }
  }
  for (const session of pending.values()) finish(session, null);
  return finished.sort((a, b) => b.last - a.last);
}

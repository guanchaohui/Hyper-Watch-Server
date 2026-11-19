export const addressOf = value => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value.trim())
  ? value.trim().toLowerCase() : "";
export const day = 86400000;
export const walletLimit = 8;
export const actionLabels = { open: "开仓", add: "加仓", reduce: "减仓", close: "平仓", reverse: "反手" };

export const notificationFieldLabels = {
  trade: "成交数量与价格",
  position: "仓位变化",
  notional: "成交名义价值",
  wallet: "钱包名称",
  pnl: "已实现盈亏",
};

export function cleanNotificationFields(value) {
  return Array.isArray(value)
    ? Object.keys(notificationFieldLabels).filter(field => value.includes(field))
    : ["trade", "position", "pnl"];
}

export function numberOf(value) {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function cleanEquityChangeAlert(value) {
  const threshold = input => {
    const number = numberOf(input);
    return number >= 0.01 && number <= 100 ? number : null;
  };
  const up = threshold(value?.up);
  const down = threshold(value?.down);
  if (up === null && down === null) return null;
  const id = typeof value.id === "string" && /^[a-f0-9-]{36}$/.test(value.id) ? value.id : null;
  return { up, down, id };
}

export function cleanProfile(value) {
  const wallets = [];
  const seen = new Set();
  let foundMine = false;
  for (const item of Array.isArray(value?.wallets) ? value.wallets : []) {
    const address = addressOf(item?.address);
    if (!address || seen.has(address) || wallets.length >= walletLimit) continue;
    seen.add(address);
    const mine = item.role === "mine" && !foundMine;
    foundMine ||= mine;
    wallets.push({
      address,
      name: typeof item.name === "string" ? item.name.trim().slice(0, 28) : "",
      group: typeof item.group === "string" ? item.group.trim().slice(0, 18) : "",
      role: mine ? "mine" : "watch",
      pinned: item.pinned === true,
      notify: item.notify === true,
    });
  }
  const rules = value?.rules ?? {};
  const positive = key => {
    const result = numberOf(rules[key]);
    return result > 0 && result <= 1e12 ? result : null;
  };
  const equityMode = rules.equityMode === "percent" ? "percent" : "amount";
  const equity = positive("equity");
  return {
    wallets,
    rules: {
      actions: Object.keys(actionLabels).filter(action => Array.isArray(rules.actions) && rules.actions.includes(action)),
      equityChangeAlert: cleanEquityChangeAlert(rules.equityChangeAlert),
      notificationFields: cleanNotificationFields(rules.notificationFields),
      equityMode,
      equity: equityMode === "percent" && equity > 100 ? null : equity,
      equityTrackingId: equityMode === "percent" && typeof rules.equityTrackingId === "string" &&
        /^[a-f0-9-]{36}$/.test(rules.equityTrackingId) ? rules.equityTrackingId : null,
      loss: positive("loss"),
      gap: positive("gap") <= 100 ? positive("gap") : null,
    },
    quick: value?.quick === true,
  };
}

export function walletName(wallet) {
  return wallet.name || wallet.address.slice(0, 6) + "…" + wallet.address.slice(-4);
}

function normalizeFill(row) {
  const time = numberOf(row?.time);
  const price = numberOf(row?.px);
  const size = numberOf(row?.sz);
  const start = numberOf(row?.startPosition);
  const signed = row?.side === "B" ? size : row?.side === "A" ? -size : 0;
  if (typeof row?.coin !== "string" || row.coin.startsWith("@") || row.coin.includes("/") ||
    !/^(Open |Close |Long >|Short >|Buy |Sell |Auto-Deleveraging|Liquidated)/i.test(row.dir ?? "") ||
    start === null || !(time > 0) || !(price > 0) || !(size > 0) || !signed) return null;
  const id = String(row.tid ?? [row.hash, row.oid, row.time, row.coin, row.sz, row.startPosition].join(":"));
  return { coin: row.coin, id, order: row.oid, time, price, size, start, delta: signed, closedPnl: numberOf(row.closedPnl) };
}

const zero = value => Math.abs(value) < 1e-9 ? 0 : value;

export function positionChanges(raw, merge = true) {
  const rows = (Array.isArray(raw) ? raw : []).map(normalizeFill).filter(Boolean)
    .sort((a, b) => a.time - b.time || Number(a.id) - Number(b.id));
  const seen = new Set();
  const groups = [];
  const latestByCoin = new Map();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const last = latestByCoin.get(row.coin);
    if (merge && last && row.order != null && row.order === last.order &&
      row.time - last.time <= 5000 && Math.abs(last.end - row.start) < 1e-8) {
      last.end = zero(row.start + row.delta);
      last.value += row.price * row.size;
      last.size += row.size;
      last.closedPnl = last.closedPnl === null || row.closedPnl === null ? null : last.closedPnl + row.closedPnl;
      last.time = row.time;
      continue;
    }
    const group = { ...row, start: zero(row.start), end: zero(row.start + row.delta), value: row.price * row.size };
    groups.push(group);
    latestByCoin.set(row.coin, group);
  }
  return groups.map(group => {
    const { start, end, size, value } = group;
    const action = start === 0 ? "open" : end === 0 ? "close" :
      Math.sign(start) !== Math.sign(end) ? "reverse" : Math.abs(end) > Math.abs(start) ? "add" : "reduce";
    const cut = action === "reduce" ? Math.max(0, 1 - Math.abs(end / start)) * 100 : null;
    return { ...group, action, price: value / size, cut };
  });
}

export function portfolioBrief(history) {
  const d = history?.day;
  return {
    equity: d?.equity.at(-1)?.[1] ?? history?.allTime?.equity.at(-1)?.[1] ?? null,
    pnl: d?.pnl.length > 1 ? d.pnl.at(-1)[1] - d.pnl[0][1] : null,
  };
}

export function utc8DayStart(now = Date.now()) {
  const offset = 8 * 60 * 60 * 1000;
  return Math.floor((now + offset) / day) * day - offset;
}

function periodCutoff(range, now) {
  if (range === "today") return utc8DayStart(now);
  if (range === "allTime") return -Infinity;
  return now - ({ week: 7, month: 30 }[range] ?? 1) * day;
}

function sampleIndex(points, time) {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i][0] <= time) return i;
  }
  return 0;
}

export function portfolioPeriodPoints(history, range, series, now = Date.now()) {
  const points = history?.[range === "today" ? "day" : range]?.[series] ?? [];
  const cutoff = periodCutoff(range, now);
  const end = points.at(-1);
  if (!end || end[0] < cutoff) return [];
  const selected = points.slice(sampleIndex(points, cutoff));
  return series === "pnl"
    ? selected.map(([time, value]) => [time, value - selected[0][1]])
    : selected;
}

export function periodPnl(history, range, now = Date.now()) {
  const points = portfolioPeriodPoints(history, range, "pnl", now);
  if (points.length < 2) return null;
  const [start] = points[0];
  const [end, pnl] = points.at(-1);
  const equities = history[range === "today" ? "day" : range].equity;
  const equity = equities[sampleIndex(equities, start)];
  return { pnl, start, equity: equity && equity[0] <= end ? equity[1] : null };
}

export function gapToLiquidation(row) {
  if (!(row?.mark > 0) || !(row?.liquidation > 0)) return null;
  return Math.max(0, (row.size > 0 ? row.mark - row.liquidation : row.liquidation - row.mark) / row.mark * 100);
}

export function cashMovements(ledger) {
  return (Array.isArray(ledger) ? ledger : []).flatMap(row => {
    const type = row?.delta?.type;
    const amount = numberOf(row?.delta?.usdc);
    if ((type !== "deposit" && type !== "withdraw") || amount === null) return [];
    return [{ type, amount: Math.abs(amount), time: numberOf(row.time) }];
  });
}

export function metricsFor(fills, funding, ledger) {
  const sum = (rows, fn) => Array.isArray(rows) ? rows.reduce((total, row) => total + (fn(row) ?? 0), 0) : null;
  const fees = new Map();
  for (const row of (fills ?? [])) {
    const token = row.feeToken || "USDC";
    fees.set(token, (fees.get(token) ?? 0) + (numberOf(row.fee) ?? 0));
  }
  return {
    realized: sum(fills, row => numberOf(row.closedPnl)),
    fees: fills === null ? null : [...fees.entries()],
    funding: sum(funding, row => numberOf(row.delta?.usdc)),
    cashFlow: sum(Array.isArray(ledger) ? cashMovements(ledger) : null, row => row.type === "deposit" ? row.amount : -row.amount),
    truncated: fills?.length >= 2000,
  };
}

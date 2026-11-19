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

export function cleanNotificationPositionUnit(value) {
  return value === "quantity" ? "quantity" : "usd";
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

export const equityVolatilityDefaults = { minutes: 15, threshold: 3 };
export const leverageAlertDefault = 3;
export const tradeCooldownDefault = 10;

export function tradeAlertSettings(wallet) {
  const seconds = numberOf(wallet?.tradeCooldown);
  const value = numberOf(wallet?.minTradeValue);
  return {
    tradeCooldown: Number.isInteger(seconds) && seconds >= 0 && seconds <= 300 ? seconds : tradeCooldownDefault,
    minTradeValue: value > 0 && value <= 1e12 ? value : 0,
  };
}

export function cleanEquityVolatility(value) {
  const minutes = numberOf(value?.minutes);
  const threshold = numberOf(value?.threshold);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 120 || !(threshold >= 0.01 && threshold <= 100)) return null;
  return { minutes, threshold };
}

export function cleanLeverageAlert(value) {
  const threshold = numberOf(value);
  return threshold >= 0.01 && threshold <= 1000 ? threshold : null;
}

export const riskFields = {
  marginUsage: ["保证金占用超过（%）", 1000],
  positionLoss: ["单仓浮亏达到（USD）", 1e12],
  positionLossRate: ["单仓亏损率达到（%）", 10000],
  positionGainRate: ["单仓收益率达到（%）", 1000000],
  dailyLoss: ["今日净亏损达到（USD）", 1e12],
  positionChange: ["持仓币种数量变化（个）", 1000, true],
  dataOutage: ["数据中断达到（分钟）", 1440, true],
};

export const riskLabels = { info: "提示", warning: "警告", critical: "紧急" };

function cleanAdvancedRisk(value) {
  const rules = {};
  for (const [key, [, max, integer]] of Object.entries(riskFields)) {
    const threshold = numberOf(value?.[key]);
    if (threshold >= 0.01 && threshold <= max && (!integer || Number.isInteger(threshold))) rules[key] = threshold;
  }
  if (!Object.keys(rules).length) return null;
  const cooldown = numberOf(value?.cooldown);
  return { ...rules, cooldown: Number.isInteger(cooldown) && cooldown >= 1 && cooldown <= 1440 ? cooldown : 15 };
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
    const { tradeCooldown, minTradeValue } = tradeAlertSettings(item);
    wallets.push({
      address,
      name: typeof item.name === "string" ? item.name.trim().slice(0, 28) : "",
      group: typeof item.group === "string" ? item.group.trim().slice(0, 18) : "",
      role: mine ? "mine" : "watch",
      pinned: item.pinned === true,
      favorite: item.favorite === true,
      notify: item.notify === true,
      ...(tradeCooldown !== tradeCooldownDefault ? { tradeCooldown } : {}),
      ...(minTradeValue ? { minTradeValue } : {}),
    });
  }
  const rules = value?.rules ?? {};
  const positive = key => {
    const result = numberOf(rules[key]);
    return result > 0 && result <= 1e12 ? result : null;
  };
  const equityMode = rules.equityMode === "percent" ? "percent" : "amount";
  const equity = positive("equity");
  const equityFloor = equityMode === "percent" && equity > 100 ? null : equity;
  const equityChange = cleanEquityChangeAlert(rules.equityChangeAlert);
  return {
    wallets,
    rules: {
      actions: Object.keys(actionLabels).filter(action => Array.isArray(rules.actions) && rules.actions.includes(action)),
      // Keep a saved protection line when older settings have both downside rules.
      equityChangeAlert: equityFloor && equityChange
        ? cleanEquityChangeAlert({ ...equityChange, down: null }) : equityChange,
      equityVolatility: cleanEquityVolatility(rules.equityVolatility),
      leverageAlert: cleanLeverageAlert(rules.leverageAlert),
      advancedRisk: cleanAdvancedRisk(rules.advancedRisk),
      pushPrivate: rules.pushPrivate === true,
      notificationFields: cleanNotificationFields(rules.notificationFields),
      notificationPositionUnit: cleanNotificationPositionUnit(rules.notificationPositionUnit),
      equityMode,
      equity: equityFloor,
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

export function fillIdentity(row) {
  return String(row.tid ?? [row.hash, row.oid, row.time, row.coin, row.sz, row.startPosition].join(":"));
}

export function isPerpCoin(coin) {
  return typeof coin === "string" && Boolean(coin) && !coin.startsWith("@") && !coin.includes("/");
}

function normalizeFill(row) {
  const time = numberOf(row?.time);
  const price = numberOf(row?.px);
  const size = numberOf(row?.sz);
  const start = numberOf(row?.startPosition);
  const signed = row?.side === "B" ? size : row?.side === "A" ? -size : 0;
  if (!isPerpCoin(row?.coin) ||
    !/^(Open |Close |Long >|Short >|Buy |Sell |Auto-Deleveraging|Liquidated)/i.test(row.dir ?? "") ||
    start === null || !(time > 0) || !(price > 0) || !(size > 0) || !signed) return null;
  const id = fillIdentity(row);
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
    equity: latestEquitySample(history)?.[1] ?? null,
    pnl: d?.pnl.length > 1 ? d.pnl.at(-1)[1] - d.pnl[0][1] : null,
  };
}

export function latestEquitySample(history) {
  return history?.day?.equity.at(-1) ?? history?.allTime?.equity.at(-1) ?? null;
}

export function positionLeverage(notional, equity) {
  return Number.isFinite(notional) && notional >= 0 && equity > 0 ? notional / equity : null;
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

// A distant prior sample does not represent the value at midnight.
export function midnightSample(points, midnight) {
  const next = points.findIndex(([time]) => time >= midnight);
  if (next < 0) return null;
  const [after, value] = points[next];
  if (after === midnight) return { value, next: next + 1, estimated: false };
  const prior = points[next - 1];
  const tolerance = 30 * 60_000;
  if (!prior || midnight - prior[0] > tolerance || after - midnight > tolerance) return null;
  const ratio = (midnight - prior[0]) / (after - prior[0]);
  return { value: prior[1] + (value - prior[1]) * ratio, next, estimated: true };
}

export function portfolioPeriodPoints(history, range, series, now = Date.now()) {
  const points = history?.[range === "today" ? "day" : range]?.[series] ?? [];
  const cutoff = periodCutoff(range, now);
  const end = points.at(-1);
  if (!end || end[0] < cutoff) return [];
  const midnight = range === "today" ? midnightSample(points, cutoff) : null;
  if (range === "today" && !midnight) return [];
  const selected = midnight ? [[cutoff, midnight.value], ...points.slice(midnight.next)] : points.slice(sampleIndex(points, cutoff));
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
  if (range === "today") {
    const midnightPnl = midnightSample(history.day.pnl, start);
    const midnightEquity = midnightSample(equities, start);
    return { pnl, start, equity: midnightEquity?.value ?? null,
      ...(midnightPnl.estimated || midnightEquity?.estimated ? { estimated: true } : {}) };
  }
  const equity = equities[sampleIndex(equities, start)];
  return { pnl, start, equity: equity && equity[0] <= end ? equity[1] : null };
}

export const todayGap = 45 * 60_000;

export function todayPortfolio(history, snapshots, now = Date.now()) {
  const midnight = utc8DayStart(now);
  const merge = (archived, official) => {
    const points = new Map([...archived, ...official].filter(([at, value]) =>
      Number.isSafeInteger(at) && at >= midnight - 30 * 60_000 && at <= now && Number.isFinite(value)));
    return [...points].sort(([left], [right]) => left - right);
  };
  const day = history?.day;
  const livePnl = day?.pnl ?? [];
  const knownPnl = new Map(livePnl);
  const savedPnl = snapshots?.pnl ?? [];
  const common = savedPnl.filter(([at]) => knownPnl.has(at));
  // Only join PnL snapshots when overlapping samples establish the same reference.
  const sameBasis = common.length >= 2 &&
    common.every(([at, value]) => Math.abs(knownPnl.get(at) - value) < 0.000001);
  const raw = {
    equity: merge(snapshots?.equity ?? [], day?.equity ?? []),
    pnl: merge(sameBasis ? savedPnl : [], livePnl),
  };
  const startOf = points => {
    const baseline = midnightSample(points, midnight);
    return baseline ? { selected: [[midnight, baseline.value], ...points.slice(baseline.next)], estimated: baseline.estimated } :
      { selected: points.filter(([at]) => at >= midnight), estimated: false };
  };
  const equity = startOf(raw.equity);
  const pnl = startOf(raw.pnl);
  const [start, initial] = pnl.selected[0] ?? [];
  const [asOf, latest] = pnl.selected.at(-1) ?? [];
  const basisEquity = equity.selected.find(([at]) => at === start)?.[1] ?? null;
  const data = pnl.selected.length >= 2 ? {
    start, asOf, pnl: latest - initial, equity: basisEquity,
    estimated: pnl.estimated, equityEstimated: start === midnight && basisEquity !== null && equity.estimated,
  } : null;
  return {
    data, pnlStart: start ?? null, equityStart: equity.selected[0]?.[0] ?? null,
    equityEstimated: equity.estimated, midnight,
    points: { equity: equity.selected, pnl: data ? pnl.selected.map(([at, value]) => [at, value - initial]) : [] },
  };
}

export function filterPositions(positions, { query = "", side = "all", sort = "notional" } = {}) {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const readers = { pnl: row => row.pnl, loss: row => row.pnl, risk: gapToLiquidation };
  const read = Object.hasOwn(readers, sort) ? readers[sort] : row => row.value;
  const ascending = sort === "loss" || sort === "risk";
  return positions.filter(row => tokens.every(part => row.coin.toLowerCase().includes(part)) &&
    (side === "long" ? row.size > 0 : side === "short" ? row.size < 0 : true)).sort((a, b) => {
    const left = read(a);
    const right = read(b);
    if (!Number.isFinite(left)) return Number(Number.isFinite(right));
    if (!Number.isFinite(right)) return -1;
    return (ascending ? left - right : right - left) || a.coin.localeCompare(b.coin);
  });
}

export function tradingActivity(changes) {
  const actions = Object.fromEntries(Object.keys(actionLabels).map(action => [action, 0]));
  const volumeByCoin = new Map();
  const hours = Array(24).fill(0);
  let volume = 0, known = 0, profitable = 0, realized = 0;
  for (const row of changes) {
    actions[row.action]++;
    volume += row.value;
    volumeByCoin.set(row.coin, (volumeByCoin.get(row.coin) ?? 0) + row.value);
    hours[(new Date(row.time).getUTCHours() + 8) % 24]++;
    if (["close", "reduce", "reverse"].includes(row.action) && Number.isFinite(row.closedPnl)) {
      known++;
      if (row.closedPnl > 0) profitable++;
      realized += row.closedPnl;
    }
  }
  const busiest = Math.max(...hours);
  return { actions, volume, realized: known ? realized : null, profitable, known,
    peakHours: hours.flatMap((count, hour) => count && count === busiest ? [hour] : []),
    topCoins: [...volumeByCoin].sort((a, b) => b[1] - a[1]).slice(0, 3) };
}

export function gapToLiquidation(row) {
  if (!(row?.mark > 0) || !(row?.liquidation > 0)) return null;
  const distance = (row.size > 0 ? row.mark - row.liquidation : row.liquidation - row.mark) / row.mark * 100;
  return Number.isFinite(distance) ? Math.max(0, distance) : null;
}

export function positionLiquidation(row) {
  const gap = gapToLiquidation(row);
  const state = gap !== null ? "priced" : row?.mode === "cross" && !(row.liquidation > 0) ? "shared" : "unavailable";
  const level = gap === null ? "unknown" : gap <= 5 ? "critical" : gap <= 15 ? "watch" : "low";
  return { state, gap, level };
}

export function positionRiskSummary(positions, { complete = false, fresh = false } = {}) {
  let closest = null;
  const rows = positions ?? [];
  for (const row of rows) {
    const { gap } = positionLiquidation(row);
    if (gap !== null && (closest === null || gap < closest.gap)) closest = { row, gap };
  }
  const sum = key => positions && rows.every(row => Number.isFinite(row[key]) && row[key] >= 0)
    ? rows.reduce((total, row) => total + row[key], 0) : null;
  const gapsComplete = Boolean(positions && complete && rows.every(row => gapToLiquidation(row) !== null));
  let level = "unknown";
  if (fresh && positions) {
    if (closest?.gap <= 5) level = "critical";
    else if (closest?.gap <= 15) level = "watch";
    else if (gapsComplete) level = rows.length ? "low" : "flat";
  }
  return { level, closest, complete: gapsComplete, notional: sum("value"), margin: sum("margin") };
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

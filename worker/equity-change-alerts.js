import { cashMovements, midnightSample, portfolioPeriodPoints, utc8DayStart } from "./analytics.js";
import { hyperliquidInfo } from "./hyperliquid.js";
import { formatEquityNotification, formatEquityReason } from "./notification-format.js";

const minute = 60_000;
export const equitySampleFreshness = 2 * minute;

export async function planEquityVolatility(db, user, address, rule, now, sample) {
  if (!sample || sample[0] < now - equitySampleFreshness || sample[0] > now + minute) return null;
  const target = "equity-volatility";
  const row = await db.prepare("SELECT breached FROM alert_status WHERE user_id = ? AND target = ?").bind(user, target).first();
  const stored = row ? JSON.parse(row.breached) : null;
  const prior = stored?.address === address ? stored : null;
  const [at, equity] = sample;
  const lastAt = prior?.samples.at(-1)?.[0] ?? 0;
  if (at <= lastAt) return null;

  const cutoff = at - rule.minutes * minute;
  const earliest = at - 121 * minute;
  const samples = (prior?.samples ?? []).filter(([time]) => time >= earliest);
  // Compare with the observation closest to the window start from inside the window.
  // Require a full window of observations and skip gaps around the start.
  const baseline = samples[0]?.[0] <= cutoff ? samples.find(([time]) => time >= cutoff && time < cutoff + 90_000) : null;
  const change = baseline?.[1] > 0 ? (equity - baseline[1]) / baseline[1] * 100 : null;
  const previousDirection = prior?.minutes === rule.minutes && prior?.threshold === rule.threshold ? prior.direction : 0;
  const direction = change === null ? previousDirection :
    Math.abs(change) >= rule.threshold - 1e-10 ? Math.sign(change) : 0;
  const swing = change !== null && direction && direction !== previousDirection ? { minutes: rule.minutes, change } : null;
  if (Math.floor(lastAt / minute) === Math.floor(at / minute)) samples.pop();
  samples.push(sample);

  return {
    swing,
    statement: db.prepare("INSERT INTO alert_status VALUES (?, ?, ?, ?) ON CONFLICT(user_id, target) DO UPDATE SET cursor = excluded.cursor, breached = excluded.breached")
      .bind(user, target, now, JSON.stringify({ address, ...rule, samples, direction })),
  };
}

export async function planEquityChange(db, user, address, rule, now, current) {
  const baseline = await readEquityChangeBaseline(db, user, address, rule);
  let reason = null;
  if (baseline !== null) {
    const delta = (current - baseline) / baseline * 100;
    if (rule.up !== null && delta >= rule.up - 1e-10) reason = formatEquityReason("up", delta);
    else if (rule.down !== null && delta <= -rule.down + 1e-10) reason = formatEquityReason("down", delta);
    if (!reason) return null;
  } else if (!(current > 0)) {
    return null;
  }
  const key = JSON.stringify({ address, ...rule });
  return {
    reason,
    statement: db.prepare("INSERT INTO alert_status VALUES (?, ?, ?, ?) ON CONFLICT(user_id, target) DO UPDATE SET cursor = excluded.cursor, breached = excluded.breached")
      .bind(user, "equity-change", now, JSON.stringify({ key, equity: current })),
  };
}

export async function accountEquityNotice(address, history, now, current, reasons, swing) {
  const points = portfolioPeriodPoints(history, "today", "equity", now);
  const startTime = utc8DayStart(now);
  const dayEquity = points.length >= 2 ? points[0][1] : null;
  let deposited = 0;
  let withdrawn = 0;
  try {
    const ledger = await hyperliquidInfo({ type: "userNonFundingLedgerUpdates", user: address, startTime, endTime: now }, true);
    const movements = cashMovements(ledger);
    deposited = movements.reduce((total, row) => row.type === "deposit" ? total + row.amount : total, 0);
    withdrawn = movements.reduce((total, row) => row.type === "withdraw" ? total + row.amount : total, 0);
  } catch {
    // The equity alert still goes out when the cash-flow lookup is unavailable.
  }
  return formatEquityNotification({
    current, dayEquity, approximate: midnightSample(history?.day?.equity ?? [], startTime)?.estimated, reasons, swing, deposited, withdrawn,
  });
}

export async function readEquityChangeBaseline(db, user, address, rule) {
  const row = await db.prepare("SELECT breached FROM alert_status WHERE user_id = ? AND target = ?")
    .bind(user, "equity-change").first();
  const saved = row ? JSON.parse(row.breached) : null;
  if (!(saved?.equity > 0)) return null;
  if (saved.key === JSON.stringify({ address, ...rule })) return saved.equity;
  // Legacy profiles can lose their duplicate downside condition while keeping the upside baseline.
  const previous = JSON.parse(saved.key ?? "null");
  return rule.down === null && rule.up !== null && previous?.down > 0 &&
    previous.address === address && previous.up === rule.up && previous.id === rule.id ? saved.equity : null;
}

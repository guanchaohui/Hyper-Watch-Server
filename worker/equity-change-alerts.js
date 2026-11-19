import { cashMovements, portfolioPeriodPoints, utc8DayStart } from "./analytics.js";
import { hyperliquidInfo } from "./hyperliquid.js";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const signedMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", signDisplay: "exceptZero" });

export async function planEquityChange(db, user, address, rule, now, current) {
  const baseline = await readEquityChangeBaseline(db, user, address, rule);
  let reason = null;
  if (baseline !== null) {
    const delta = (current - baseline) / baseline * 100;
    if (rule.up !== null && delta >= rule.up - 1e-10) reason = "较上次基准上涨 " + delta.toFixed(2) + "%";
    else if (rule.down !== null && delta <= -rule.down + 1e-10) reason = "较上次基准下跌 " + Math.abs(delta).toFixed(2) + "%";
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

export async function accountEquityNotice(address, history, now, current, reasons) {
  const points = portfolioPeriodPoints(history, "today", "equity", now);
  const baseline = points[0]?.[1];
  const hasToday = points.length >= 2 && baseline > 0;
  const delta = hasToday ? current - baseline : null;
  const change = hasToday ? delta / baseline * 100 : null;
  const sign = change > 0 ? "+" : "";
  const today = hasToday ? "今日 " + sign + change.toFixed(2) + "%" : "账户权益提醒";
  const title = (change === null || change === 0 ? "" : change > 0 ? "📈 " : "📉 ") +
    (hasToday ? "账户权益 · " + today : today);
  const startTime = utc8DayStart(now);
  const timing = points[0]?.[0] === startTime ? "UTC+8 零点" : "UTC+8 零点附近样本";
  const lines = [
    hasToday ? timing + "起 " + signedMoney.format(delta) + "，当前 " + money.format(current)
      : "当前权益 " + money.format(current) + "，今日样本不足",
    "触发：" + reasons.join("；"),
  ];
  try {
    const ledger = await hyperliquidInfo({ type: "userNonFundingLedgerUpdates", user: address, startTime, endTime: now }, true);
    const movements = cashMovements(ledger);
    const deposited = movements.reduce((total, row) => row.type === "deposit" ? total + row.amount : total, 0);
    const withdrawn = movements.reduce((total, row) => row.type === "withdraw" ? total + row.amount : total, 0);
    if (deposited || withdrawn) {
      lines.push([deposited && "今日入金 " + signedMoney.format(deposited),
        withdrawn && "今日出金 " + signedMoney.format(-withdrawn)].filter(Boolean).join(" · "));
    }
  } catch {
    // The equity alert still goes out when the cash-flow lookup is unavailable.
  }
  return { title, body: lines.join("\n") };
}

export async function readEquityChangeBaseline(db, user, address, rule) {
  const row = await db.prepare("SELECT breached FROM alert_status WHERE user_id = ? AND target = ?")
    .bind(user, "equity-change").first();
  const saved = row ? JSON.parse(row.breached) : null;
  return saved?.key === JSON.stringify({ address, ...rule }) && saved.equity > 0 ? saved.equity : null;
}

import { addressOf, cleanEquityChangeAlert, cleanEquityVolatility, cleanLeverageAlert, cleanNotificationFields, cleanNotificationPositionUnit,
  equityVolatilityDefaults, leverageAlertDefault, numberOf, positionLeverage, walletName } from "./analytics.js";

const quantity = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const price = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 10 });
const currency = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const signedCurrency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", signDisplay: "exceptZero" });
const realized = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2, maximumFractionDigits: 8, signDisplay: "exceptZero",
});
const verbs = { open: "开", add: "加", reduce: "减", close: "平", reverse: "反手做" };

function formatQuantity(value) {
  if (!Number.isFinite(value)) return "—";
  if (value !== 0 && Math.abs(value) < 0.001) return (value < 0 ? "−" : "") + "<0.001";
  return quantity.format(value);
}

function formatNotional(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  return value > 0 && value < 0.01 ? "<$0.01" : currency.format(value);
}

function formatPositionValue(size, unitPrice, showDirection) {
  if (!Number.isFinite(size)) return "—";
  if (size === 0) return formatNotional(0);
  const amount = Math.abs(size) * unitPrice;
  const direction = showDirection && Number.isFinite(amount) ? (size < 0 ? "空 " : "多 ") : "";
  return direction + formatNotional(amount);
}

export function formatFillNotification(wallet, change, fields, positionUnit) {
  const { coin, action, start, end, size, price: fillPrice, value, closedPnl, count } = change;
  const symbol = typeof coin === "string" ? coin.split(":").at(-1).trim() || "合约" : "合约";
  const direction = action === "close" ? start : end;
  const side = Number.isFinite(direction) && direction !== 0 ? (direction > 0 ? "多" : "空") : "";
  const verb = Object.hasOwn(verbs, action) ? verbs[action] : "";
  const marker = side === "多" ? "🟢 " : side === "空" ? "🔴 " : "";
  const title = marker + symbol + " · " + (verb && side ? verb + side : "仓位变动") + (count > 1 ? " · " + count + " 笔" : "");
  const name = typeof wallet?.name === "string" ? wallet.name.trim() : "";
  const address = addressOf(wallet?.address);
  const validPrice = Number.isFinite(fillPrice) && fillPrice > 0;
  const validSize = Number.isFinite(size) && size > 0;
  const notional = Number.isFinite(value) && value > 0 ? value : validSize && validPrice ? size * fillPrice : null;
  const unitPrice = validPrice ? fillPrice : (validSize && Number.isFinite(notional) ? notional / size : NaN);
  const changedDirection = Number.isFinite(start) && Number.isFinite(end) && Math.sign(start) * Math.sign(end) < 0;
  const position = cleanNotificationPositionUnit(positionUnit) === "quantity"
    ? "仓位：" + formatQuantity(start) + " → " + formatQuantity(end) + " 张"
    : "仓位价值：" + formatPositionValue(start, unitPrice, changedDirection) + " → " + formatPositionValue(end, unitPrice, changedDirection);
  const lines = {
    trade: "成交：" + (validSize ? formatQuantity(size) + " 张" : "—") + " @ " + (validPrice ? "$" + price.format(fillPrice) : "—"),
    position,
    notional: "名义价值：" + formatNotional(notional),
    wallet: name.replace(/\s+/g, " ") || (address ? walletName({ address }) : "未命名钱包"),
    pnl: ["reduce", "close", "reverse"].includes(action)
      ? "已实现盈亏：" + (Number.isFinite(closedPnl) ? realized.format(closedPnl) : "—") : "",
  };
  const body = cleanNotificationFields(fields).map(field => lines[field]).filter(Boolean).join("\n");
  return { title, body };
}

const sampleFill = {
  coin: "NVDA", action: "reduce", start: 3.192, end: 2.431, size: 0.761, price: 160.05, closedPnl: -25.5,
};

export function formatEquityReason(type, value, level) {
  if (type === "amount") return "低于固定线 " + currency.format(level);
  const prefix = { up: "较上次基准上涨 ", down: "较上次基准下跌 ", percent: "较最高点回落 " };
  const change = prefix[type] + Math.abs(value).toFixed(2) + "%";
  return type === "percent" ? change + "（提醒线 " + currency.format(level) + "）" : change;
}

export function formatEquityNotification({ current, dayEquity, approximate = false, reasons, swing, deposited = 0, withdrawn = 0 }) {
  const hasToday = Number.isFinite(dayEquity) && dayEquity > 0;
  const delta = current - dayEquity;
  const change = hasToday ? 100 * (delta / dayEquity) : 0;
  const marker = change > 0 ? "📈 " : change < 0 ? "📉 " : "";
  const dayLabel = (change > 0 ? "+" : "") + change.toFixed(2) + "%";
  const title = swing ? (swing.change > 0 ? "📈" : "📉") + " 权益波动 · " +
    swing.minutes + " 分钟 " + (swing.change > 0 ? "+" : "") + swing.change.toFixed(2) + "%"
    : marker + (hasToday ? "账户权益 · 今日 " + dayLabel : "账户权益提醒");
  const timing = approximate ? "UTC+8 零点（估算）" : "UTC+8 零点";
  const lines = swing
    ? [hasToday ? (approximate ? "今日约 " : "今日 ") + dayLabel + "（" + signedCurrency.format(delta) + "）" : "今日样本不足",
      "当前权益 " + currency.format(current)]
    : [hasToday ? timing + "起 " + signedCurrency.format(delta) + "，当前 " + currency.format(current)
      : "当前权益 " + currency.format(current) + "，今日样本不足"];
  if (reasons.length) lines.push("触发：" + reasons.join("；"));
  if (deposited || withdrawn) {
    lines.push([deposited && "今日入金 " + signedCurrency.format(deposited),
      withdrawn && "今日出金 " + signedCurrency.format(-withdrawn)].filter(Boolean).join(" · "));
  }
  return { title, body: lines.join("\n") };
}

export function formatLeverageNotification(ratio, threshold, notional, equity) {
  const rounded = ratio.toFixed(2);
  return {
    title: Number(rounded) > threshold ? "⚠️ 总杠杆率 · " + rounded + "×" : "⚠️ 总杠杆率超限",
    body: "超过提醒线 " + threshold + "×\n名义仓位 " + currency.format(notional) + "\n账户权益 " + currency.format(equity),
  };
}

export function formatNotificationPreview(options = {}) {
  const { type, name, notificationFields, notificationPositionUnit, up, down, downsideMode, amount, peakDrop, volatility, leverage } = options ?? {};
  if (type === "volatility") {
    const config = cleanEquityVolatility(volatility) ?? equityVolatilityDefaults;
    const current = 1000 * (1 + config.threshold / 100);
    return formatEquityNotification({
      current, dayEquity: 980, swing: { minutes: config.minutes, change: config.threshold }, reasons: [],
    });
  }
  if (type === "leverage") {
    const threshold = cleanLeverageAlert(leverage) ?? leverageAlertDefault;
    const equity = 1000;
    const notional = equity * (threshold + 0.25);
    return formatLeverageNotification(positionLeverage(notional, equity), threshold, notional, equity);
  }
  if (type === "up" || type === "down") {
    const rule = cleanEquityChangeAlert({ up, down });
    const upSample = type === "up";
    const mode = upSample ? "up" : downsideMode === "amount" || downsideMode === "percent" ? downsideMode : "down";
    const drop = numberOf(peakDrop);
    const change = upSample ? rule?.up ?? 5 : mode === "percent" ? (drop > 0 && drop <= 100 ? drop : 5) : rule?.down ?? 5;
    const base = 1000;
    const floor = numberOf(amount);
    const current = mode === "amount" ? (floor > 0 && floor <= 1e12 ? floor : 950) :
      base * (1 + (upSample ? change : -change) / 100);
    const dayEquity = mode === "amount" ? current / 0.93 : upSample ? 980 : 1020;
    return formatEquityNotification({
      current, dayEquity, reasons: [formatEquityReason(mode, change, current)],
    });
  }
  const sampleName = typeof name === "string" ? name.trim().slice(0, 28) : "";
  return formatFillNotification({ name: sampleName || "示例钱包" }, sampleFill, notificationFields, notificationPositionUnit);
}

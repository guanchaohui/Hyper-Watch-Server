import { addressOf, cleanEquityChangeAlert, cleanNotificationFields, walletName } from "./analytics.js";

const quantity = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const price = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 10 });
const currency = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const realized = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2, maximumFractionDigits: 8, signDisplay: "exceptZero",
});
const verbs = { open: "开", add: "加", reduce: "减", close: "平", reverse: "反手做" };

function formatQuantity(value) {
  if (!Number.isFinite(value)) return "—";
  if (value !== 0 && Math.abs(value) < 0.001) return (value < 0 ? "−" : "") + "<0.001";
  return quantity.format(value);
}

export function formatFillNotification(wallet, change, fields) {
  const { coin, action, start, end, size, price: fillPrice, value, closedPnl } = change;
  const symbol = typeof coin === "string" ? coin.split(":").at(-1).trim() || "合约" : "合约";
  const direction = action === "close" ? start : end;
  const side = Number.isFinite(direction) && direction !== 0 ? (direction > 0 ? "多" : "空") : "";
  const verb = Object.hasOwn(verbs, action) ? verbs[action] : "";
  const marker = side === "多" ? "🟢 " : side === "空" ? "🔴 " : "";
  const title = marker + symbol + " · " + (verb && side ? verb + side : "仓位变动");
  const name = typeof wallet?.name === "string" ? wallet.name.trim() : "";
  const address = addressOf(wallet?.address);
  const validPrice = Number.isFinite(fillPrice) && fillPrice > 0;
  const validSize = Number.isFinite(size) && size > 0;
  const notional = Number.isFinite(value) && value > 0 ? value : validSize && validPrice ? size * fillPrice : null;
  const notionalLabel = Number.isFinite(notional) && notional > 0
    ? (notional < 0.01 ? "<$0.01" : currency.format(notional)) : "—";
  const lines = {
    trade: "成交：" + (validSize ? formatQuantity(size) + " 张" : "—") + " @ " + (validPrice ? "$" + price.format(fillPrice) : "—"),
    position: "仓位：" + formatQuantity(start) + " → " + formatQuantity(end) + " 张",
    notional: "名义价值：" + notionalLabel,
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

export function formatEquityChangeNotification(from, to, change) {
  const up = change > 0;
  return {
    title: (up ? "📈 账户权益上涨 " : "📉 账户权益下跌 ") + Math.abs(change).toFixed(2) + "%",
    body: (up ? "增加 " : "减少 ") + currency.format(Math.abs(to - from)) +
      "\n" + currency.format(from) + " → " + currency.format(to),
  };
}


export function formatNotificationPreview(options = {}) {
  const { type, name, notificationFields, up, down } = options ?? {};
  if (type === "up" || type === "down") {
    const rule = cleanEquityChangeAlert({ up, down });
    const change = type === "up" ? rule?.up ?? 5 : -(rule?.down ?? 5);
    return formatEquityChangeNotification(1000, 1000 + 10 * change, change);
  }
  const sampleName = typeof name === "string" ? name.trim().slice(0, 28) : "";
  return formatFillNotification({ name: sampleName || "示例钱包" }, sampleFill, notificationFields);
}

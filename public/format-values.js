import { numberOf } from "./analytics.js";

const decimals = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const abbreviated = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

export function formatMoney(value, { symbol = "$", unit = "", signed = false, compact = false } = {}) {
  const number = numberOf(value);
  if (number === null) return "—";
  const magnitude = Math.abs(number);
  const sign = number < 0 ? "-" : signed && number > 0 ? "+" : "";
  const suffix = unit ? " " + unit : "";
  if (magnitude > 0 && magnitude < 0.005) return sign + "<" + symbol + "0.01" + suffix;
  const display = compact && magnitude >= 10000 ? abbreviated : decimals;
  return sign + symbol + display.format(magnitude) + suffix;
}

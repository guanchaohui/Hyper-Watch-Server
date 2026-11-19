import { periodPnl, riskLabels, walletName } from "./analytics.js";
import { equitySampleFreshness } from "./equity-change-alerts.js";

const minute = 60_000;
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const pct = value => value.toFixed(2) + "%";
const ranks = { info: 0, warning: 1, critical: 2 };

export function riskPath(wallet, coin) {
  const params = new URLSearchParams({ wallet });
  if (coin) params.set("position", coin);
  return "/?" + params;
}

export function riskDetails(db, user, id, wallet, level, coin) {
  return db.prepare("INSERT OR IGNORE INTO alert_details VALUES (?, ?, ?)")
    .bind(user, id, JSON.stringify({ level, path: riskPath(wallet, coin) }));
}

export async function privatePush(payload, enabled) {
  if (!enabled) return payload;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload.tag));
  const tag = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { ...payload, title: "盯盘提醒", body: "你有一条新的盯盘提醒，打开看板查看。",
    tag: "private-" + tag, path: "/#alerts" };
}

export function evaluateRisk(rule, prior, now, positions, portfolio, sample) {
  const saved = prior ?? {};
  const state = { watchedAt: saved.watchedAt ?? now, healthyAt: saved.healthyAt ?? null,
    count: saved.count ?? null, countAt: saved.countAt ?? null, active: { ...saved.active } };
  const notices = [];
  const freshEquity = Number.isFinite(sample?.[1]) && sample[0] <= now && now - sample[0] <= equitySampleFreshness;
  function check(key, threshold, value, label, format, coin, normalLevel = "warning") {
    if (!threshold) { delete state.active[key]; return; }
    if (!Number.isFinite(value)) return;
    const old = state.active[key];
    if (value < threshold) {
      if (old) state.active[key] = { ...old, breached: false };
      return;
    }
    const level = normalLevel === "warning" && value >= threshold * 2 ? "critical" : normalLevel;
    const sameThreshold = old?.threshold === threshold;
    const cooledDown = !sameThreshold || (now - old.sentAt >= rule.cooldown * minute &&
      (!old.breached || now - old.sentAt >= Math.max(60, rule.cooldown) * minute));
    if (cooledDown || ranks[level] > ranks[old.level]) {
      notices.push({ key, level, coin, text: label + " " + format(value) + "（阈值 " + format(threshold) + "）" });
      state.active[key] = { threshold, level, breached: true, sentAt: now };
    } else state.active[key] = { ...old, breached: true };
  }

  if (positions && freshEquity) state.healthyAt = now;
  const outage = (now - (state.healthyAt ?? state.watchedAt)) / minute;
  check("outage", rule.dataOutage, outage, "数据已中断", n => Math.floor(n) + " 分钟");
  if (positions) {
    const marginKnown = positions.every(row => Number.isFinite(row.margin));
    const marginUsage = marginKnown && freshEquity && sample[1] > 0
      ? positions.reduce((sum, row) => sum + row.margin, 0) / sample[1] * 100 : null;
    check("margin", rule.marginUsage, marginUsage, "保证金占用", pct);
    const elapsed = now - state.countAt;
    const countChange = state.count !== null && elapsed <= 5 * minute ? Math.abs(positions.length - state.count) : null;
    check("count", rule.positionChange, countChange, "持仓币种数量变化", n => n + " 个", null, "info");
    state.count = positions.length;
    state.countAt = now;
    const current = new Set();
    for (const row of positions) {
      const checks = [
        ["loss", rule.positionLoss, row.pnl === null ? null : -row.pnl, "单仓浮亏", money.format, "warning"],
        ["lossRate", rule.positionLossRate, row.returnOnEquity === null ? null : -row.returnOnEquity * 100, "单仓亏损率", pct, "warning"],
        ["gainRate", rule.positionGainRate, row.returnOnEquity === null ? null : row.returnOnEquity * 100, "单仓收益率", pct, "info"],
      ];
      for (const [kind, threshold, value, label, format, level] of checks) {
        const key = kind + ":" + row.coin;
        current.add(key);
        check(key, threshold, value, row.coin + " " + label, format, row.coin, level);
      }
    }
    for (const key of Object.keys(state.active)) {
      if (key.includes(":") && !current.has(key)) {
        if (now - state.active[key].sentAt >= rule.cooldown * minute) delete state.active[key];
        else state.active[key].breached = false;
      }
    }
  }
  const freshPnl = (portfolio?.day?.pnl?.at(-1)?.[0] ?? 0) >= now - equitySampleFreshness;
  const daily = freshEquity && freshPnl && rule.dailyLoss ? periodPnl(portfolio, "today", now) : null;
  check("daily", rule.dailyLoss, daily ? -daily.pnl : null, "今日净亏损" + (daily?.estimated ? "（估算）" : ""), money.format);
  return { state, notices };
}

export async function planAdvancedRisk(db, user, wallet, rule, now, positions, portfolio, sample) {
  const target = "advanced-risk:" + wallet.address;
  const prior = await db.prepare("SELECT breached FROM alert_status WHERE user_id = ? AND target = ?").bind(user, target).first();
  const { state, notices } = evaluateRisk(rule, prior ? JSON.parse(prior.breached) : null, now, positions, portfolio, sample);
  const writes = [db.prepare("INSERT INTO alert_status VALUES (?, ?, ?, ?) ON CONFLICT(user_id, target) DO UPDATE SET cursor=excluded.cursor, breached=excluded.breached")
    .bind(user, target, now, JSON.stringify(state))];
  // Group rules for the same position and severity into one notification and record.
  const groups = new Map();
  for (const { level, coin, text } of notices) {
    const key = JSON.stringify([level, coin ?? null]);
    if (!groups.has(key)) groups.set(key, { level, coin, lines: [] });
    groups.get(key).lines.push(text);
  }
  const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  for (const [key, { level, coin, lines }] of groups) {
    const id = "risk:" + wallet.address + ":" + now + ":" + key;
    const title = riskLabels[level] + " · " + (coin ?? walletName(wallet));
    const body = clock + "（UTC+8）\n" + lines.join("\n");
    writes.push(db.prepare("INSERT OR IGNORE INTO alerts (user_id,event_id,body,created_at,title) VALUES (?,?,?,?,?)")
      .bind(user, id, body, now, title), riskDetails(db, user, id, wallet.address, level, coin));
  }
  return writes;
}

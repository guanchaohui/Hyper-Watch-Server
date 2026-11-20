import { planAdvancedRisk, privatePush, riskDetails } from "./advanced-risk.js";
import { planPositionRisks } from "./risk-episodes.js";
import { fullPositionSnapshot } from "./position-source.js";
import { cleanProfile, day, latestEquitySample, positionLeverage, walletName } from "./analytics.js";
import { parsePortfolio, parsePositions } from "./market.js";
import { hyperliquidInfo } from "./hyperliquid.js";
import { accountEquityNotice, equitySampleFreshness, planEquityChange, planEquityVolatility, readEquityChangeBaseline } from "./equity-change-alerts.js";
import { saveAlertHealth, savePushHealth } from "./alert-health.js";
import { sendPush } from "./push.js";
import { quietAt, recordQuietAlerts } from "./quiet-hours.js";
import { formatEquityReason, formatLeverageNotification } from "./notification-format.js";

import { flushFillAlerts, recordFillAlerts } from "./trade-alerts.js";
export { recordFillAlerts } from "./trade-alerts.js";

export const alertCheckMinutes = 60;

function alertInsert(db, user, id, body, now, title = null) {
  return db.prepare("INSERT OR IGNORE INTO alerts (user_id, event_id, body, created_at, title) VALUES (?, ?, ?, ?, ?)")
    .bind(user, id, body, now, title);
}

async function watchFills(db, user, wallet, rules, now) {
  const target = "fills:" + wallet.address;
  const existing = await db.prepare("SELECT cursor FROM alert_status WHERE user_id = ? AND target = ?").bind(user, target).first();
  const end = now - 3000;
  const time = existing?.cursor ?? end;
  const start = Math.min(end, Math.max(time - 2000, now - day));
  if (existing) {
    const rows = await hyperliquidInfo({ type: "userFillsByTime", user: wallet.address, startTime: start, endTime: end, aggregateByTime: false }, true);
    await recordFillAlerts(db, user, wallet, rules, rows, start);
  }
  await db.prepare("INSERT INTO alert_status VALUES (?, ?, ?, '[]') ON CONFLICT(user_id, target) DO UPDATE SET cursor = excluded.cursor")
    .bind(user, target, end).run();
}

async function readEquityPeak(db, user, address, trackingId) {
  const row = await db.prepare("SELECT breached FROM alert_status WHERE user_id = ? AND target = ?")
    .bind(user, "equity-peak:" + address).first();
  const saved = row ? JSON.parse(row.breached) : null;
  return saved?.trackingId === trackingId && saved.peak > 0 ? saved.peak : null;
}

export async function equityAlertLevels(db, user) {
  const row = await db.prepare("SELECT settings FROM profiles WHERE user_id = ?").bind(user).first();
  const { wallets, rules } = cleanProfile(row ? JSON.parse(row.settings) : null);
  const mine = wallets.find(wallet => wallet.role === "mine");
  if (!mine) return { hasWallet: false };

  const change = rules.equityChangeAlert;
  const peakMode = rules.equityMode === "percent";
  const [baseline, peak] = await Promise.all([
    change ? readEquityChangeBaseline(db, user, mine.address, change) : null,
    peakMode && rules.equity ? readEquityPeak(db, user, mine.address, rules.equityTrackingId) : null,
  ]);
  return {
    hasWallet: true,
    change: change ? {
      baseline,
      up: baseline !== null && change.up !== null ? baseline * (1 + change.up / 100) : null,
      down: baseline !== null && change.down !== null ? baseline * (1 - change.down / 100) : null,
    } : null,
    floor: rules.equity ? {
      peakMode,
      peak,
      down: peakMode ? (peak !== null ? peak * (1 - rules.equity / 100) : null) : rules.equity,
    } : null,
  };
}

async function trackEquityPeak(db, user, address, trackingId, equity, now, statements) {
  const target = "equity-peak:" + address;
  const peak = await readEquityPeak(db, user, address, trackingId);
  if (peak !== null && peak >= equity) return peak;
  if (!(equity > 0)) return null;
  statements.push(db.prepare("INSERT INTO alert_status VALUES (?, ?, ?, ?) ON CONFLICT(user_id, target) DO UPDATE SET cursor = excluded.cursor, breached = excluded.breached")
    .bind(user, target, now, JSON.stringify({ trackingId, peak: equity })));
  return equity;
}

async function watchRisk(db, user, wallet, rules, now) {
  const target = "risk:" + wallet.address;
  const prior = await db.prepare("SELECT breached FROM alert_status WHERE user_id = ? AND target = ?").bind(user, target).first();
  const old = new Set(JSON.parse(prior?.breached ?? "[]"));
  const next = new Set([...old].filter(key => key !== "loss" && !key.startsWith("gap:") && !key.startsWith("gap-critical:")));
  const advanced = rules.advancedRisk;
  const needsEquity = rules.equity || rules.equityChangeAlert || rules.equityVolatility || rules.leverageAlert ||
    advanced?.marginUsage || advanced?.dailyLoss || advanced?.dataOutage;
  const needsFullPositions = rules.gap || rules.leverageAlert || (advanced && Object.keys(advanced).some(key => key !== "dailyLoss" && key !== "cooldown"));
  const [equityResult, positionResult, leverageResult] = await Promise.allSettled([
    needsEquity ? hyperliquidInfo({ type: "portfolio", user: wallet.address }, true).then(parsePortfolio) : Promise.resolve(null),
    rules.loss || rules.gap ? hyperliquidInfo({ type: "clearinghouseState", user: wallet.address }, true).then(raw => ({ rows: parsePositions([["", raw]]), at: Date.now() })) : null,
    needsFullPositions ? fullPositionSnapshot(wallet.address, true) : Promise.resolve(null),
  ]);
  // The portfolio response can include a sample generated after the scan started.
  const observedAt = Date.now();
  const observations = [];
  const statements = [];
  const equityReasons = [];
  const positionReasons = [];
  const sample = latestEquitySample(equityResult.value);
  const equity = sample?.[1] ?? null;
  let swing = null;
  const percentMode = rules.equityMode === "percent" && rules.equity;
  const percentKey = "equity-percent:" + (rules.equityTrackingId ?? "initial");
  const leverageKey = "leverage:" + rules.leverageAlert;
  for (const key of old) {
    if ((key === "equity" && percentMode) || (key.startsWith("equity-percent:") && (!percentMode || key !== percentKey))) next.delete(key);
    if (key.startsWith("leverage:") && (!rules.leverageAlert || key !== leverageKey)) next.delete(key);
  }
  if (equityResult.status === "fulfilled") {
    if (rules.equityVolatility) {
      const movement = await planEquityVolatility(db, user, wallet.address, rules.equityVolatility, now, sample);
      if (movement) {
        statements.push(movement.statement);
        swing = movement.swing;
      }
    }
    if (Number.isFinite(equity) && rules.equityChangeAlert) {
      const change = await planEquityChange(db, user, wallet.address, rules.equityChangeAlert, now, equity);
      if (change) {
        statements.push(change.statement);
        if (change.reason) equityReasons.push(change.reason);
      }
    }
    if (percentMode && Number.isFinite(equity)) {
      const peak = await trackEquityPeak(db, user, wallet.address, rules.equityTrackingId, equity, now, statements);
      if (peak !== null) {
        const drop = (peak - equity) / peak * 100;
        observations.push([percentKey, drop >= rules.equity,
          formatEquityReason("percent", drop, peak * (1 - rules.equity / 100))]);
      }
    } else if (!percentMode && (equity !== null || !rules.equity)) {
      observations.push(["equity", rules.equity && equity <= rules.equity, formatEquityReason("amount", null, rules.equity)]);
    }
  }
  for (const [key, breached, body] of observations) {
    if (!breached) next.delete(key);
    else {
      next.add(key);
      if (!old.has(key)) equityReasons.push(body);
    }
  }
  if (rules.gap || rules.loss) {
    const { id, notices, writes } = await planPositionRisks(db, user, wallet.address, rules, observedAt, positionResult.value, leverageResult.value, old);
    statements.push(...writes);
    if (notices.length) {
      const snapshots = notices.flatMap(item => item.snapshot ? [item.snapshot] : []);
      const level = notices.some(item => item.tier >= 2) ? "critical" : "warning";
      const coin = snapshots.length === 1 ? snapshots[0].coin : null;
      const positionTier = notices.find(item => item.snapshot)?.tier;
      const pushTitle = coin && (positionTier >= 2 || level === "warning") ? coin +
        (positionTier === 3 ? " · 强平风险升级" : positionTier === 2 ? " · 紧急强平预警" : " · 接近强平") : null;
      const compact = snapshots.slice(0, 2).map(row => row.coin + " · " +
        (row.mode === "isolated" ? "逐仓 " : row.mode === "cross" ? "全仓 " : "") +
        (row.leverage ? row.leverage + "× · " : "") + "距强平 " + row.distance.toFixed(2) + "%");
      if (snapshots.length > 2) compact.push("另有 " + (snapshots.length - 2) + " 个仓位");
      if (snapshots.length && notices.some(item => item.key === "loss")) compact.push("同时触发合约净浮亏提醒");
      const pushBody = compact.join("\n");
      statements.push(alertInsert(db, user, id, notices.map(item => item.text).join("\n"), observedAt, "仓位风险 · " + walletName(wallet)),
        riskDetails(db, user, id, wallet.address, level, coin, { snapshots, ...(pushTitle && { pushTitle }), ...(pushBody && { pushBody }) }));
    }
  } else {
    statements.push(db.prepare("DELETE FROM alert_status WHERE user_id = ? AND target = ?").bind(user, "position-risk:" + wallet.address));
  }
  const perps = leverageResult.value?.rows;
  if (rules.leverageAlert && perps?.every(row => row.value !== null) && sample && sample[0] >= now - equitySampleFreshness) {
    const notional = perps.reduce((total, row) => total + row.value, 0);
    const leverage = positionLeverage(notional, equity);
    if (leverage !== null) {
      if (leverage <= rules.leverageAlert) next.delete(leverageKey);
      else {
        next.add(leverageKey);
        if (!old.has(leverageKey)) {
          const notice = formatLeverageNotification(leverage, rules.leverageAlert, notional, equity);
          const id = "leverage:" + wallet.address + ":" + now;
          statements.push(alertInsert(db, user, id, notice.body, now, notice.title),
            riskDetails(db, user, id, wallet.address, leverage >= rules.leverageAlert * 2 ? "critical" : "warning"));
        }
      }
    }
  }
  if (swing || equityReasons.length) {
    const notice = await accountEquityNotice(wallet.address, equityResult.value, observedAt, equity, equityReasons, swing, db);
    const id = "equity:" + wallet.address + ":" + now;
    statements.push(alertInsert(db, user, id, notice.body, now, notice.title),
      riskDetails(db, user, id, wallet.address, equityReasons.some(reason => reason.includes("下跌") || reason.includes("低于") || reason.includes("回落")) ? "warning" : "info"));
  }
  if (rules.advancedRisk) {
    statements.push(...await planAdvancedRisk(db, user, wallet, rules.advancedRisk, observedAt, perps, equityResult.value, sample, rules.isolatedMinValue, leverageResult.value?.at));
  } else {
    statements.push(db.prepare("DELETE FROM alert_status WHERE user_id = ? AND target = ?").bind(user, "advanced-risk:" + wallet.address));
  }
  statements.push(db.prepare("INSERT INTO alert_status VALUES (?, ?, ?, ?) ON CONFLICT(user_id, target) DO UPDATE SET cursor = excluded.cursor, breached = excluded.breached")
    .bind(user, target, now, JSON.stringify([...next])));
  await db.batch(statements);
  return [equityResult, positionResult, leverageResult].some(result => result.status === "rejected") ? "partial" : "ok";
}

async function deliver(env, user, now, ensureLease) {
  const { results: devices } = await env.DB.prepare("SELECT endpoint, subscription FROM push_devices WHERE user_id = ?")
    .bind(user).all();
  const profile = await env.DB.prepare("SELECT settings FROM profiles WHERE user_id = ?").bind(user).first();
  const { pushPrivate, quietHours } = cleanProfile(profile ? JSON.parse(profile.settings) : null).rules;
  await recordQuietAlerts(env.DB, user, quietHours, now);
  const quietNow = quietAt(quietHours, now);
  let sent = 0;
  for (const device of devices) {
    const subscription = JSON.parse(device.subscription);
    const { results: items } = await env.DB.prepare(
      "SELECT a.event_id, a.title, a.body, a.created_at, d.details FROM alerts a LEFT JOIN alert_details d USING (user_id,event_id) WHERE a.user_id = ? AND a.created_at >= ? AND coalesce(json_extract(d.details, '$.quiet'),0)=0 AND (?=0 OR json_extract(d.details, '$.level')='critical') AND NOT EXISTS (SELECT 1 FROM transmissions t WHERE t.user_id = a.user_id AND t.event_id = a.event_id AND t.endpoint = ?) ORDER BY a.created_at LIMIT 25",
    ).bind(user, Math.max(subscription.since, now - day), Number(quietNow), device.endpoint).all();
    for (const item of items) {
      if (!await ensureLease()) return sent;
      const reasons = item.event_id.startsWith("risk:") ? item.body.split("\n") : [];
      const body = reasons.length > 4 ? reasons.slice(0, 4).join("\n") +
        "\n另有 " + (reasons.length - 4) + " 项，打开提醒记录查看。" : item.body;
      try {
        const details = item.details ? JSON.parse(item.details) : null;
        const result = await sendPush(env, subscription, await privatePush({
          title: details?.pushTitle ?? (item.title || "盯盘提醒"),
          body: details?.pushBody ?? body,
          timestamp: item.created_at,
          urgency: details ? (details.level === "critical" ? "high" : "normal") : item.title ? "high" : "normal",
          tag: item.event_id,
          account: user,
          path: details?.path,
        }, pushPrivate));
        if (result === "sent") {
          await env.DB.prepare("INSERT OR IGNORE INTO transmissions VALUES (?, ?, ?)")
            .bind(user, item.event_id, device.endpoint).run();
          sent++;
        }
        await savePushHealth(env.DB, user, device.endpoint, result);
        if (result === "expired") {
          await env.DB.prepare("DELETE FROM push_devices WHERE user_id = ? AND endpoint = ?").bind(user, device.endpoint).run();
        }
        if (result !== "sent") break;
      } catch {
        await savePushHealth(env.DB, user, device.endpoint, "failed");
        // Leave the event pending for a later run.
        break;
      }
    }
  }
  return sent;
}

async function deliverWithLease(env, user) {
  if (!env.VAPID_PRIVATE || !env.VAPID_PUBLIC) return 0;
  const name = "delivery:" + user;
  const holder = crypto.randomUUID();
  const now = Date.now();
  let until = now + 30_000;
  const lock = await env.DB.prepare(
    "INSERT INTO task_leases VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, lease_until = excluded.lease_until WHERE task_leases.lease_until <= ?",
  ).bind(name, holder, until, now).run();
  if (lock.meta.changes !== 1) return 0;
  try {
    return await deliver(env, user, now, async () => {
      const time = Date.now();
      if (until - time > 14_000) return true;
      until = time + 30_000;
      const result = await env.DB.prepare("UPDATE task_leases SET lease_until = ? WHERE name = ? AND holder = ?")
        .bind(until, name, holder).run();
      return result.meta.changes === 1;
    });
  } finally {
    await env.DB.prepare("DELETE FROM task_leases WHERE name = ? AND holder = ?").bind(name, holder).run();
  }
}

const deliveryQueue = new Map();

export function queueAlertDelivery(env, user) {
  const previous = deliveryQueue.get(user);
  if (previous) {
    previous.pending = true;
    return previous.promise;
  }
  const state = { pending: true };
  state.promise = (async () => {
    let sent = 0;
    while (state.pending) {
      state.pending = false;
      sent += await deliverWithLease(env, user);
    }
    return sent;
  })().finally(() => deliveryQueue.delete(user));
  deliveryQueue.set(user, state);
  return state.promise;
}

async function checkProfile(env, profile, now, background) {
  const { user_id: user } = profile;
  const holder = crypto.randomUUID();
  const name = "alerts:" + user;
  const started = Date.now();
  const lock = await env.DB.prepare(
    "INSERT INTO task_leases VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, lease_until = excluded.lease_until WHERE task_leases.lease_until < ?",
  ).bind(name, holder, started + 180000, started).run();
  if (lock.meta.changes !== 1) return null;
  try {
    const { wallets, rules } = cleanProfile(JSON.parse(profile.settings));
    const targets = wallets.filter(wallet => wallet.notify && rules.actions.length);
    const mine = wallets.find(wallet => wallet.role === "mine");
    const jobs = targets.map(wallet => watchFills(env.DB, user, wallet, rules, now));
    if (mine && (rules.equity || rules.loss || rules.gap || rules.equityChangeAlert || rules.equityVolatility || rules.leverageAlert || rules.advancedRisk)) {
      jobs.push(watchRisk(env.DB, user, mine, rules, now));
    }
    const outcomes = await Promise.allSettled(jobs);
    if (targets.length) await flushFillAlerts(env.DB, Date.now(), user);
    const failures = outcomes.filter(result => result.status === "rejected" || result.value === "partial").length;
    if (background) await saveAlertHealth(env.DB, user, "cloud-scan-health", { checked: outcomes.length, failures });
    return {
      checked: outcomes.length,
      failures,
      sent: await queueAlertDelivery(env, user),
    };
  } finally {
    await env.DB.prepare("UPDATE task_leases SET lease_until = ? WHERE name = ? AND holder = ?")
      .bind(Date.now() + 12000, name, holder).run();
  }
}

export async function checkAlerts(env, account) {
  const now = Date.now();
  const query = account
    ? env.DB.prepare("SELECT user_id, settings FROM profiles WHERE user_id = ?").bind(account)
    : env.DB.prepare("SELECT user_id, settings FROM profiles");
  const { results } = await query.all();
  const summary = { status: "ok", checked: 0, failures: 0, sent: 0 };
  for (const profile of results) {
    const outcome = await checkProfile(env, profile, now, !account);
    if (!outcome) {
      if (account) return { status: "running" };
      continue;
    }
    summary.checked += outcome.checked;
    summary.failures += outcome.failures;
    summary.sent += outcome.sent;
  }
  if (!account) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM trade_alert_buffer WHERE finalized = 1 AND trade_at < ?").bind(now - day * 14),
      env.DB.prepare("DELETE FROM transmissions WHERE NOT EXISTS (SELECT 1 FROM alerts a WHERE a.user_id = transmissions.user_id AND a.event_id = transmissions.event_id)"),
    ]);
  }
  return summary;
}

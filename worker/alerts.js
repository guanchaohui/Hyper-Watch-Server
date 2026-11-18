import { actionLabels, cleanProfile, day, gapToLiquidation, portfolioBrief, positionChanges, walletName } from "./analytics.js";
import { parsePortfolio, parsePositions, queryInfo } from "./market.js";
import { sendPush } from "./push.js";

export const alertCheckMinutes = 60;
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

async function saveEvent(db, user, id, body, now) {
  return db.prepare("INSERT OR IGNORE INTO alerts (user_id, event_id, body, created_at) VALUES (?, ?, ?, ?)")
    .bind(user, id, body, now).run();
}

async function watchFills(db, user, wallet, selected, now) {
  const target = "fills:" + wallet.address;
  const existing = await db.prepare("SELECT cursor FROM alert_status WHERE user_id = ? AND target = ?").bind(user, target).first();
  const end = now - 3000;
  const time = existing?.cursor ?? end;
  const start = Math.min(end, Math.max(time - 2000, now - day));
  if (existing) {
    const rows = await queryInfo("userFillsByTime", wallet.address, undefined, { startTime: start, endTime: end, aggregateByTime: true });
    const changes = positionChanges(rows, false).filter(change => change.time >= start && selected.includes(change.action));
    if (changes.length) {
      await db.batch(changes.slice(-150).map(change => {
        const id = "fill:" + wallet.address + ":" + change.id;
        const body = walletName(wallet) + " · " + change.coin + " " + actionLabels[change.action];
        return db.prepare("INSERT OR IGNORE INTO alerts (user_id, event_id, body, created_at) VALUES (?, ?, ?, ?)")
          .bind(user, id, body, change.time);
      }));
    }
  }
  await db.prepare("INSERT INTO alert_status VALUES (?, ?, ?, '[]') ON CONFLICT(user_id, target) DO UPDATE SET cursor = excluded.cursor")
    .bind(user, target, end).run();
}

async function watchRisk(db, user, wallet, rules, now) {
  const target = "risk:" + wallet.address;
  const prior = await db.prepare("SELECT breached FROM alert_status WHERE user_id = ? AND target = ?").bind(user, target).first();
  const old = new Set(JSON.parse(prior?.breached ?? "[]"));
  const next = new Set(old);
  const [equityResult, positionResult] = await Promise.allSettled([
    rules.equity ? queryInfo("portfolio", wallet.address).then(parsePortfolio) : Promise.resolve(null),
    rules.loss || rules.gap ? queryInfo("clearinghouseState", wallet.address).then(raw => parsePositions([["", raw]])) : Promise.resolve([]),
  ]);
  const observations = [];
  if (equityResult.status === "fulfilled") {
    const equity = portfolioBrief(equityResult.value).equity;
    if (equity !== null || !rules.equity) {
      observations.push(["equity", rules.equity && equity <= rules.equity, "权益已低于 " + money.format(rules.equity ?? 0)]);
    }
  }
  if (positionResult.status === "fulfilled") {
    const positions = positionResult.value;
    if (positions.every(row => row.pnl !== null) || !rules.loss) {
      const total = positions.reduce((sum, row) => sum + (row.pnl ?? 0), 0);
      observations.push(["loss", rules.loss && -total >= rules.loss, "主市场合约浮亏达到 " + money.format(rules.loss ?? 0)]);
    }
    const monitored = new Set();
    if (rules.gap) for (const row of positions) {
      const gap = gapToLiquidation(row);
      if (gap === null) continue;
      const key = "gap:" + row.coin;
      monitored.add(key);
      observations.push([key, gap <= rules.gap, row.coin + " 距预估强平价 " + gap.toFixed(2) + "%"]);
    }
    for (const key of old) if (key.startsWith("gap:") && !monitored.has(key)) next.delete(key);
  }
  for (const [key, breached, body] of observations) {
    if (!breached) next.delete(key);
    else {
      next.add(key);
      if (!old.has(key)) {
        await saveEvent(db, user, "risk:" + wallet.address + ":" + key + ":" + Math.floor(now / 60000), walletName(wallet) + " · " + body, now);
      }
    }
  }
  await db.prepare("INSERT INTO alert_status VALUES (?, ?, ?, ?) ON CONFLICT(user_id, target) DO UPDATE SET cursor = excluded.cursor, breached = excluded.breached")
    .bind(user, target, now, JSON.stringify([...next])).run();
}

async function deliver(env, user, now) {
  if (!env.VAPID_PRIVATE || !env.VAPID_PUBLIC) return 0;
  const { results: devices } = await env.DB.prepare("SELECT endpoint, subscription FROM push_devices WHERE user_id = ?")
    .bind(user).all();
  let sent = 0;
  for (const device of devices) {
    const subscription = JSON.parse(device.subscription);
    const { results: items } = await env.DB.prepare(
      "SELECT a.event_id, a.body FROM alerts a WHERE a.user_id = ? AND a.created_at >= ? AND NOT EXISTS (SELECT 1 FROM transmissions t WHERE t.user_id = a.user_id AND t.event_id = a.event_id AND t.endpoint = ?) ORDER BY a.created_at LIMIT 25",
    ).bind(user, Math.max(subscription.since, now - day), device.endpoint).all();
    for (const item of items) {
      try {
        const result = await sendPush(env, subscription, {
          title: "Hyper 盯盘",
          body: item.body,
          tag: item.event_id,
        });
        if (result === "expired") {
          await env.DB.prepare("DELETE FROM push_devices WHERE user_id = ? AND endpoint = ?").bind(user, device.endpoint).run();
          break;
        }
        await env.DB.prepare("INSERT OR IGNORE INTO transmissions VALUES (?, ?, ?)").bind(user, item.event_id, device.endpoint).run();
        sent++;
      } catch {
        // Leave the event pending for a later run.
        break;
      }
    }
  }
  return sent;
}

export async function checkAlerts(env) {
  const now = Date.now();
  const holder = crypto.randomUUID();
  const lock = await env.DB.prepare(
    "INSERT INTO task_leases VALUES ('alerts', ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, lease_until = excluded.lease_until WHERE task_leases.lease_until < ?",
  ).bind(holder, now + 180000, now).run();
  if (lock.meta.changes !== 1) return { status: "running" };
  let checked = 0;
  let failures = 0;
  let sent = 0;
  try {
    const { results } = await env.DB.prepare("SELECT user_id, settings FROM profiles").all();
    for (const profile of results) {
      const { user_id: user } = profile;
      const { wallets, rules } = cleanProfile(JSON.parse(profile.settings));
      const targets = wallets.filter(wallet => wallet.notify && rules.actions.length);
      const mine = wallets.find(wallet => wallet.role === "mine");
      const jobs = targets.map(wallet => watchFills(env.DB, user, wallet, rules.actions, now));
      if (mine && (rules.equity || rules.loss || rules.gap)) jobs.push(watchRisk(env.DB, user, mine, rules, now));
      const outcomes = await Promise.allSettled(jobs);
      checked += outcomes.length;
      failures += outcomes.filter(result => result.status === "rejected").length;
      sent += await deliver(env, user, now);
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM transmissions WHERE NOT EXISTS (SELECT 1 FROM alerts a WHERE a.user_id = transmissions.user_id AND a.event_id = transmissions.event_id AND a.created_at >= ?)").bind(now - day * 14),
      env.DB.prepare("DELETE FROM alerts WHERE created_at < ?").bind(now - day * 14),
    ]);
    return { status: "ok", checked, failures, sent };
  } finally {
    await env.DB.prepare("UPDATE task_leases SET lease_until = ? WHERE name = 'alerts' AND holder = ?").bind(Date.now() + 12000, holder).run();
  }
}

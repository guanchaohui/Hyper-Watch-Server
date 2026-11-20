const minute = 60_000;
const recoveryTime = 5 * minute;
const maxSampleGap = 3 * minute;
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function eligiblePosition(row, minimum) {
  return !(minimum > 0 && row.mode === "isolated" && Number.isFinite(row.value) && row.value < minimum);
}

export function liquidationDistance(row) {
  if (!(row.mark > 0) || !(row.liquidation > 0)) return null;
  return Math.max(0, Math.sign(row.size) * (row.mark - row.liquidation) / row.mark * 100);
}

export function riskSnapshot(row, sampledAt) {
  return {
    coin: row.coin, sampledAt, mode: row.mode, leverage: row.leverage,
    side: row.size > 0 ? "long" : "short", entry: row.entry, mark: row.mark,
    liquidation: row.liquidation, notional: row.value, pnl: row.pnl,
    distance: liquidationDistance(row),
  };
}

function observe(previous, tier, recovered, at, settings) {
  const old = previous?.settings === settings ? previous : null;
  if (old && at <= old.at) return { state: old, changed: false };
  if (tier && (!old || tier > old.tier)) {
    return { state: { tier, at, settings, clearSince: null }, changed: true };
  }
  if (!old) return { state: null, changed: false };
  const clearSince = recovered ? (at - old.at <= maxSampleGap ? old.clearSince ?? at : at) : null;
  if (clearSince !== null && at - clearSince >= recoveryTime) return { state: null, changed: false };
  return { state: { ...old, at, clearSince }, changed: false };
}

export async function planPositionRisks(db, user, wallet, rules, now, main, full, legacy = new Set()) {
  const target = "position-risk:" + wallet;
  const stored = await db.prepare("SELECT breached FROM alert_status WHERE user_id = ? AND target = ?").bind(user, target).first();
  const state = JSON.parse(stored?.breached ?? "{}");
  const notices = [];
  const updates = new Map();

  function track(key, tier, recovered, at, settings, text, snapshot, legacyKey = key) {
    const prior = state[key] ?? (!stored && legacy.has(legacyKey) ? { tier: 1, at: at - 1, settings } : null);
    const result = observe(prior, tier, recovered, at, settings);
    if (!result.state) delete state[key];
    else state[key] = result.state;
    if (result.changed) notices.push({ key, tier, text, snapshot });
    else if (result.state?.event && snapshot && tier && result.state !== prior) {
      const latest = updates.get(result.state.event) ?? {};
      latest[key] = snapshot;
      updates.set(result.state.event, latest);
    }
  }

  if (!rules.loss) delete state.loss;
  else if (main?.rows.every(row => Number.isFinite(row.pnl))) {
    const loss = -main.rows.reduce((total, row) => total + row.pnl, 0);
    const tier = loss >= rules.loss * 2 ? 2 : Number(loss >= rules.loss);
    track("loss", tier, loss < rules.loss * .9, main.at, String(rules.loss), "合约净浮亏达到 " + money.format(loss));
  }

  const snapshot = full ?? main;
  const seen = new Set();
  if (rules.gap && snapshot) for (const row of snapshot.rows) {
    const key = "gap:" + row.coin + ":" + Math.sign(row.size);
    seen.add(key);
    if (!eligiblePosition(row, rules.isolatedMinValue)) continue;
    const gap = liquidationDistance(row);
    if (gap === null) continue;
    const critical = Math.min(rules.gap, 4);
    const severe = Math.min(critical, 3);
    const tier = gap <= severe + 1e-9 ? 3 : gap <= critical + 1e-9 ? 2 : Number(gap <= rules.gap + 1e-9);
    track(key, tier, gap >= Math.min(100, rules.gap + 1), snapshot.at, String(rules.gap),
      row.coin + " 距离强平还剩 " + gap.toFixed(2) + "%", riskSnapshot(row, snapshot.at), "gap:" + row.coin);
  }
  for (const key of Object.keys(state)) {
    if (key.startsWith("gap:") && (!rules.gap || (full && !seen.has(key)))) delete state[key];
  }

  const id = "risk:" + wallet + ":" + now;
  for (const notice of notices) state[notice.key].event = id;
  const writes = [db.prepare("INSERT INTO alert_status VALUES (?, ?, ?, ?) ON CONFLICT(user_id,target) DO UPDATE SET cursor=excluded.cursor,breached=excluded.breached")
    .bind(user, target, now, JSON.stringify(state))];
  for (const [event, latest] of updates) writes.push(db.prepare(
    "UPDATE alert_details SET details=json_set(details,'$.latest',json_patch(coalesce(json_extract(details,'$.latest'),'{}'),json(?))) WHERE user_id=? AND event_id=?",
  ).bind(JSON.stringify(latest), user, event));
  return { id, notices, writes };
}

import { positionChanges, tradeAlertSettings } from "./analytics.js";
import { formatFillNotification } from "./notification-format.js";

const batchScope = "user_id = ? AND wallet = ? AND batch_id = ? AND finalized = 0 AND due_at <= ?";
const queueTrade = `
  WITH latest AS (
    SELECT trade_at, batch_id, start_at, due_at, payload FROM trade_alert_buffer
    WHERE user_id = ? AND wallet = ? AND coin = ? AND finalized = 0 AND due_at > ?
    ORDER BY trade_at DESC, rowid DESC LIMIT 1
  ), compatible AS (
    SELECT batch_id, start_at, due_at FROM latest
    WHERE trade_at <= ? AND start_at >= ?
      AND json_extract(payload, '$.change.action') = ?
      AND ABS(json_extract(payload, '$.change.end') - ?) < 1e-8
      AND json_extract(payload, '$.seconds') = ? AND json_extract(payload, '$.minimum') = ?
  )
  INSERT OR IGNORE INTO trade_alert_buffer
    (user_id, wallet, fill_id, coin, batch_id, start_at, due_at, trade_at, payload)
  SELECT ?, ?, ?, ?, COALESCE((SELECT batch_id FROM compatible), ?),
    COALESCE((SELECT start_at FROM compatible), ?), COALESCE((SELECT due_at FROM compatible), ?), ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE user_id = ? AND event_id = ?)
`;

function endTradeBatch(db, user, address, change, now) {
  return db.prepare(`
    UPDATE trade_alert_buffer AS pending SET due_at = ?
    WHERE pending.user_id = ? AND pending.wallet = ? AND pending.coin = ?
      AND pending.finalized = 0 AND pending.due_at > ? AND pending.trade_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM trade_alert_buffer AS later
        WHERE later.user_id = pending.user_id AND later.wallet = pending.wallet
          AND later.batch_id = pending.batch_id AND later.trade_at > ?
      )
  `).bind(now, user, address, change.coin, now, change.time, change.time);
}

export async function recordFillAlerts(db, user, wallet, rules, rows, earliest = 0) {
  const trades = positionChanges(rows, false).filter(change => change.time >= earliest);
  if (!trades.length) return false;
  const { actions, notificationFields: fields, notificationPositionUnit: positionUnit } = rules;
  const { tradeCooldown: seconds, minTradeValue: minimum } = tradeAlertSettings(wallet);
  const now = Date.now();
  const statements = [];
  for (const change of trades) {
    const adjust = change.action === "add" || change.action === "reduce";
    if (!adjust && seconds) statements.push(endTradeBatch(db, user, wallet.address, change, now));
    if (!actions.includes(change.action)) continue;
    const id = "fill:" + wallet.address + ":" + change.id;
    if (adjust && (seconds || minimum)) {
      const data = JSON.stringify({ change, name: wallet.name, seconds, minimum, fields, positionUnit });
      statements.push(db.prepare(queueTrade).bind(
        user, wallet.address, change.coin, now, change.time, change.time - seconds * 1000, change.action,
        change.start, seconds, minimum, user, wallet.address, change.id, change.coin, change.id,
        change.time, now + seconds * 1000, change.time, data, user, id,
      ));
    } else {
      const { title, body } = formatFillNotification(wallet, change, fields, positionUnit);
      statements.push(adjust ? db.prepare(
        "INSERT OR IGNORE INTO alerts (user_id, event_id, title, body, created_at) SELECT ?, ?, ?, ?, ? " +
        "WHERE NOT EXISTS (SELECT 1 FROM trade_alert_buffer WHERE user_id = ? AND wallet = ? AND fill_id = ?)",
      ).bind(user, id, title, body, change.time, user, wallet.address, change.id) :
        db.prepare("INSERT OR IGNORE INTO alerts (user_id, event_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(user, id, title, body, change.time));
    }
  }
  if (!statements.length) return false;
  return (await db.batch(statements)).some(result => result.meta.changes);
}

export async function flushFillAlerts(db, now = Date.now(), account) {
  const query = db.prepare("SELECT user_id, wallet, batch_id FROM trade_alert_buffer WHERE finalized = 0 AND due_at <= ?" +
    (account ? " AND user_id = ?" : "") + " GROUP BY user_id, wallet, batch_id ORDER BY MIN(due_at) LIMIT 50");
  const { results: batches } = await query.bind(...(account ? [now, account] : [now])).all();
  const ready = new Set();
  for (const { user_id: user, wallet, batch_id: batch } of batches) {
    const scope = [user, wallet, batch, now];
    const { results } = await db.prepare("SELECT payload FROM trade_alert_buffer WHERE " + batchScope +
      " ORDER BY trade_at, rowid").bind(...scope).all();
    if (!results.length) continue;
    const entries = results.map(row => JSON.parse(row.payload));
    const { change: first, name, minimum, fields, positionUnit } = entries[0];
    const count = entries.length;
    const value = entries.reduce((sum, item) => sum + item.change.value, 0);
    const guard = "(SELECT COUNT(*) FROM trade_alert_buffer WHERE " + batchScope + ") = ?";
    const statements = [];
    if (value >= minimum) {
      const size = entries.reduce((sum, item) => sum + item.change.size, 0);
      const last = entries.at(-1).change;
      const closedPnl = entries.every(item => Number.isFinite(item.change.closedPnl))
        ? entries.reduce((sum, item) => sum + item.change.closedPnl, 0) : null;
      const notice = formatFillNotification({ address: wallet, name }, {
        ...first, end: last.end, count, size, price: value / size, value, closedPnl,
      }, fields, positionUnit);
      const id = count === 1 ? "fill:" + wallet + ":" + first.id : "fill:" + wallet + ":batch:" + batch;
      statements.push(db.prepare(
        "INSERT OR IGNORE INTO alerts (user_id, event_id, body, created_at, title) SELECT ?, ?, ?, ?, ? WHERE " + guard,
      ).bind(user, id, notice.body, last.time, notice.title, ...scope, count));
    }
    statements.push(db.prepare("UPDATE trade_alert_buffer SET finalized = 1 WHERE " + batchScope + " AND " + guard)
      .bind(...scope, ...scope, count));
    const resultsWritten = await db.batch(statements);
    if (statements.length > 1 && resultsWritten[0].meta.changes) ready.add(user);
  }
  return ready;
}

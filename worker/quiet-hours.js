const hour = 3_600_000;
const day = 24 * hour;
const localTime = "(a.created_at + 28800000) % 86400000";
const level = "coalesce(json_extract(d.details, '$.level'), '')";
const offsetOf = value => Number(value.slice(0, 2)) * hour + Number(value.slice(3)) * 60_000;

export function quietAt(quiet, now) {
  if (!quiet) return false;
  const at = (now + 8 * hour) % day;
  const start = offsetOf(quiet.start), end = offsetOf(quiet.end);
  return start < end ? at >= start && at < end : at >= start || at < end;
}

export async function recordQuietAlerts(db, user, quiet, now) {
  if (!quiet) return;
  const start = offsetOf(quiet.start), end = offsetOf(quiet.end);
  const join = start < end ? "AND" : "OR";
  await db.prepare(`INSERT INTO alert_details (user_id,event_id,details)
    SELECT a.user_id,a.event_id,'{"quiet":true}' FROM alerts a LEFT JOIN alert_details d USING(user_id,event_id)
    WHERE a.user_id=? AND a.created_at BETWEEN ? AND ?
      AND (${localTime} >= ? ${join} ${localTime} < ?)
      AND ${level} <> 'critical' AND coalesce(json_extract(d.details, '$.quiet'), 0) = 0
      AND NOT EXISTS (SELECT 1 FROM transmissions t WHERE t.user_id=a.user_id AND t.event_id=a.event_id)
    ON CONFLICT(user_id,event_id) DO UPDATE SET details=json_set(alert_details.details,'$.quiet',json('true'))`)
    .bind(user, Math.max(now - day, quiet.since ?? 0), now, start, end).run();
}

export async function recentQuietSummary(db, user, now = Date.now()) {
  const { results } = await db.prepare(`SELECT substr(a.event_id,1,instr(a.event_id,':')-1) AS kind,count(*) AS count
    FROM alerts a JOIN alert_details d USING(user_id,event_id)
    WHERE a.user_id=? AND a.created_at BETWEEN ? AND ? AND json_extract(d.details,'$.quiet')=1 GROUP BY kind`)
    .bind(user, now - day, now).all();
  return Object.fromEntries(results.map(row => [row.kind, row.count]));
}

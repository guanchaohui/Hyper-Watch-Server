const pageSize = 20;
export const inboxKinds = new Set(["all", "fill", "equity", "leverage", "risk"]);

export async function readInbox(db, user, { kind, unread, before }) {
  const clauses = ["a.user_id = ?"];
  const bindings = [user];
  if (kind !== "all") {
    clauses.push("a.event_id LIKE ?");
    bindings.push(kind + ":%");
  }
  if (unread) clauses.push("r.read_at IS NULL");
  if (before) {
    clauses.push("(a.created_at, a.event_id) < (?, ?)");
    bindings.push(before.time, before.id);
  }
  const { results } = await db.prepare(
    "SELECT a.event_id AS id, a.title, a.body, a.created_at AS time, r.read_at AS readAt, d.details FROM alerts a " +
    "LEFT JOIN alert_reads r ON r.user_id = a.user_id AND r.event_id = a.event_id " +
    "LEFT JOIN alert_details d ON d.user_id = a.user_id AND d.event_id = a.event_id " +
    "WHERE " + clauses.join(" AND ") + " ORDER BY a.created_at DESC, a.event_id DESC LIMIT ?",
  ).bind(...bindings, pageSize + 1).all();
  const items = results.slice(0, pageSize).map(row => ({ ...row, details: row.details ? JSON.parse(row.details) : null }));
  const last = items.at(-1);
  return { items, next: results.length > pageSize ? { time: last.time, id: last.id } : null };
}

export async function markInboxRead(db, user, id, now = Date.now()) {
  await db.prepare(
    "INSERT OR IGNORE INTO alert_reads (user_id, event_id, read_at) " +
    "SELECT user_id, event_id, ? FROM alerts WHERE user_id = ? AND event_id = ?",
  ).bind(now, user, id).run();
}
